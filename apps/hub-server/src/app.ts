import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvConfig } from "@agents-hub/config";
import {
  AppError,
  ClaimLockInputSchema,
  CreateProjectInputSchema,
  JoinSessionInputSchema,
  MAX_MESSAGE_BODY_BYTES,
  ReportStatusInputSchema,
  SendMessageInputSchema,
  SessionActionInputSchema,
  UuidSchema,
  decodeCursor,
  encodeCursor,
} from "@agents-hub/shared";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { isEventVisibleToAgent } from "./application/policies/event-visibility.js";
import { AuditService } from "./application/services/audit-service.js";
import { IdempotencyService } from "./application/services/idempotency-service.js";
import { LockService } from "./application/services/lock-service.js";
import { MembershipService } from "./application/services/membership-service.js";
import { MessageService } from "./application/services/message-service.js";
import { ProjectService } from "./application/services/project-service.js";
import { SessionService } from "./application/services/session-service.js";
import { StatusService } from "./application/services/status-service.js";
import { WsTicketService } from "./application/services/ws-ticket-service.js";
import { type AuthContext, AuthService } from "./http/auth/auth-service.js";
import { registerMembershipRoutes } from "./http/routes/membership-routes.js";
import { registerStaticRoutes } from "./http/routes/static-routes.js";
import { WebSocketHub } from "./http/websocket/ws-hub.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { SqliteEventBus } from "./infrastructure/event-bus/event-bus.js";
import { RateLimiter } from "./infrastructure/security/rate-limiter.js";
import { redactSecrets } from "./infrastructure/security/redactor.js";

export interface AppContext {
  db: DatabaseSync;
  eventBus: SqliteEventBus;
  wsHub: WebSocketHub;
  authService: AuthService;
  projectService: ProjectService;
  sessionService: SessionService;
  messageService: MessageService;
  statusService: StatusService;
  lockService: LockService;
  auditService: AuditService;
  wsTicketService: WsTicketService;
  rateLimiter: RateLimiter;
  membershipService: MembershipService;
  idempotencyService: IdempotencyService;
}

export function buildApp(
  config?: Partial<EnvConfig>,
  customDb?: DatabaseSync,
  customRateLimiter?: RateLimiter,
): FastifyInstance & { ctx: AppContext } {
  const db = customDb ?? createDatabase(config?.DATABASE_URL ?? ":memory:");
  const eventBus = new SqliteEventBus(db);
  const wsHub = new WebSocketHub(1024 * 1024, config?.WS_MAX_CONNECTIONS ?? 200);
  eventBus.subscribe((event) => wsHub.broadcast(event));

  const authService = new AuthService(db);
  const projectService = new ProjectService(db, eventBus);
  const sessionService = new SessionService(db, eventBus);
  const messageService = new MessageService(db, eventBus);
  const statusService = new StatusService(db, eventBus);
  const lockService = new LockService(db, eventBus);
  const auditService = new AuditService(db);
  const wsTicketService = new WsTicketService(db);
  const membershipService = new MembershipService(db, eventBus, authService, auditService);
  const idempotencyService = new IdempotencyService(db, eventBus);
  const rateLimiter =
    customRateLimiter ??
    new RateLimiter({
      ipRule: { windowMs: 60_000, max: config?.RATE_LIMIT_IP_PER_MINUTE ?? 60000 },
      identityRule: { windowMs: 60_000, max: config?.RATE_LIMIT_USER_PER_MINUTE ?? 3000 },
    });

  const ctx: AppContext = {
    db,
    eventBus,
    wsHub,
    authService,
    projectService,
    sessionService,
    messageService,
    statusService,
    lockService,
    auditService,
    wsTicketService,
    rateLimiter,
    membershipService,
    idempotencyService,
  };

  const app = fastify({
    logger: {
      level: config?.LOG_LEVEL ?? "silent",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "token",
          "ticket",
          "AGENTS_HUB_TOKEN",
          "body",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split("?")[0] ?? "/" }),
        err: (err) => ({ type: err.name, message: "Request failed", stack: "", code: err.code }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024, // 64 KiB
  });

  // Assign ctx
  (app as unknown as { ctx: AppContext }).ctx = ctx;

  // CORS
  const corsOrigins = (config?.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim());
  if (corsOrigins.includes("*") && config?.NODE_ENV === "production")
    throw new Error("Production requires an exact CORS allowlist");
  void app.register(fastifyCors, {
    origin: corsOrigins,
    credentials: !corsOrigins.includes("*"),
  });

  // WebSocket
  void app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });

  // Hook to handle requestId, rate limiting and header security
  app.addHook("onRequest", async (req, reply) => {
    const inputId = req.headers["x-request-id"];
    const reqId =
      typeof inputId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(inputId)
        ? inputId
        : crypto.randomUUID();
    reply.header("x-request-id", reqId);
    req.id = reqId;

    // Apply rate limiting on non-health endpoints
    if (!req.url.startsWith("/health")) {
      let authIdentity: string | undefined;
      if (req.headers.authorization) {
        try {
          authIdentity = getAuth(req).userId;
        } catch (error) {
          rateLimiter.check(req, reply);
          throw error;
        }
      }
      rateLimiter.check(req, reply, authIdentity);
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const auth = authCache.get(req);
    app.log.info(
      {
        request_id: reply.getHeader("x-request-id"),
        method: req.method,
        path: req.routeOptions.url ?? "/unmatched",
        status: reply.statusCode,
        ...(auth
          ? { actor_id: createHash("sha256").update(auth.userId).digest("hex").slice(0, 16) }
          : {}),
        ...((req.params as { projectId?: string })?.projectId
          ? {
              project_id: createHash("sha256")
                .update((req.params as { projectId: string }).projectId)
                .digest("hex")
                .slice(0, 16),
            }
          : {}),
      },
      "request.completed",
    );
  });

  const maintenance = setInterval(
    () => {
      try {
        lockService.expireLocks();
        sessionService.expireSessions(config?.SESSION_IDLE_SECONDS, config?.SESSION_EXPIRE_SECONDS);
        wsTicketService.cleanup();
        wsHub.revalidate();
        const before = new Date(
          Date.now() - (config?.EVENT_RETENTION_DAYS ?? 30) * 86400000,
        ).toISOString();
        eventBus.transaction(() => {
          db.prepare("DELETE FROM events WHERE occurred_at < ?").run(before);
          db.prepare("DELETE FROM messages WHERE created_at < ?").run(before);
          db.prepare(
            "DELETE FROM status_reports WHERE reported_at < ? AND status_id NOT IN (SELECT status_id FROM status_reports s WHERE reported_at = (SELECT MAX(reported_at) FROM status_reports WHERE project_id = s.project_id AND agent_id = s.agent_id))",
          ).run(before);
          db.prepare("DELETE FROM idempotency_records WHERE expires_at <= ?").run(
            new Date().toISOString(),
          );
        });
      } catch (error) {
        app.log.error({ err: error }, "maintenance.failed");
      }
    },
    (config?.MAINTENANCE_INTERVAL_SECONDS ?? 15) * 1000,
  );
  maintenance.unref();

  app.addHook("preClose", async () => {
    wsHub.closeAll(1001, "Server shutting down");
  });
  // Graceful shutdown hook
  app.addHook("onClose", async () => {
    wsHub.closeAll(1001, "Server shutting down");
    rateLimiter.destroy();
    clearInterval(maintenance);
  });

  app.setErrorHandler((error, req, reply) => {
    const requestId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    if (error instanceof AppError) {
      const statusMap: Record<string, number> = {
        UNAUTHENTICATED: 401,
        FORBIDDEN: 403,
        PROJECT_NOT_FOUND: 404,
        INVALID_INPUT: 422,
        MESSAGE_TOO_LARGE: 413,
        CURSOR_INVALID: 400,
        LOCK_CONFLICT: 409,
        LOCK_NOT_OWNER: 403,
        SESSION_EXPIRED: 401,
        RATE_LIMITED: 429,
        INTERNAL_ERROR: 500,
        IDEMPOTENCY_CONFLICT: 409,
        STATE_CONFLICT: 409,
      };
      const statusCode = statusMap[error.code] ?? 500;
      const rejectedAuth = authCache.get(req);
      if (rejectedAuth && ["POST", "PATCH", "DELETE"].includes(req.method)) {
        const rejectedProject = (req.params as { projectId?: string })?.projectId;
        auditService.logAction(
          rejectedAuth.userId,
          "request.reject",
          req.routeOptions.url ?? "unknown",
          "failure",
          requestId,
          UuidSchema.safeParse(rejectedProject).success ? rejectedProject : undefined,
        );
      }
      return reply.status(statusCode).send({
        error: {
          code: error.code,
          message: redactSecrets(error.message) as string,
          request_id: requestId,
          ...(error.details ? { details: redactSecrets(error.details) } : {}),
        },
        request_id: requestId,
      });
    }

    const err = error as { statusCode?: number; message?: string };
    return reply.status(err.statusCode ?? 500).send({
      error: {
        code:
          err.statusCode === 413
            ? "MESSAGE_TOO_LARGE"
            : err.statusCode === 400
              ? "INVALID_INPUT"
              : "INTERNAL_ERROR",
        message:
          err.statusCode === 413
            ? "Request body too large"
            : err.statusCode === 400
              ? "Invalid request"
              : "An unexpected error occurred",
        request_id: requestId,
      },
      request_id: requestId,
    });
  });

  const authCache = new WeakMap<FastifyRequest, AuthContext>();
  function getAuth(req: FastifyRequest): AuthContext {
    const cached = authCache.get(req);
    if (cached) return cached;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("UNAUTHENTICATED", "Missing or malformed Authorization header");
    }
    const token = authHeader.substring(7).trim();
    const auth = authService.verifyToken(token);
    authCache.set(req, auth);
    return auth;
  }

  function requireScope(auth: AuthContext, requiredScope: string): void {
    const scopes = auth.scopes ?? [];
    if (scopes.includes("*") || scopes.includes(requiredScope)) {
      return;
    }
    throw new AppError(
      "FORBIDDEN",
      `Insufficient token scope: requires '${requiredScope}', found [${scopes.join(", ")}]`,
    );
  }

  function getAuthenticatedUserId(req: FastifyRequest, requiredScope?: string): string {
    const auth = getAuth(req);
    if (requiredScope) {
      requireScope(auth, requiredScope);
    }
    const params = req.params as { projectId?: string };
    const body = req.body as { project_id?: string } | undefined;
    const requestedProject = params?.projectId ?? body?.project_id;
    if (auth.projectId && requestedProject && auth.projectId !== requestedProject)
      throw new AppError("FORBIDDEN", "Token is bound to another project");
    if (
      params?.projectId &&
      requiredScope?.endsWith(":write") &&
      requiredScope !== "sessions:write"
    ) {
      authService.checkProjectPermission(auth.userId, params.projectId, true);
    }
    return auth.userId;
  }

  function command<T>(
    req: FastifyRequest,
    userId: string,
    projectId: string,
    operation: string,
    payload: unknown,
    fn: () => T,
    bodyKey?: unknown,
  ): T {
    return idempotencyService.execute(
      userId,
      projectId,
      operation,
      bodyKey ?? req.headers["idempotency-key"],
      payload,
      () =>
        eventBus.transaction(() => {
          const result = fn();
          if (operation === "message.create" || operation === "status.report") {
            const entity = result as { message_id?: string; status_id?: string };
            auditService.logAction(
              userId,
              operation,
              entity.message_id ?? entity.status_id ?? projectId,
              "success",
              String(req.id),
              projectId,
            );
          }
          return result;
        }),
    );
  }

  // --- HEALTH ENDPOINTS ---
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (req, reply) => {
    try {
      const dbCheck = db.prepare("SELECT 1 AS ready").get() as { ready?: number } | undefined;
      if (!dbCheck || dbCheck.ready !== 1) {
        throw new Error("SQLite readiness check failed");
      }
      if (config?.NODE_ENV === "production")
        return { status: "ready", request_id: reply.getHeader("x-request-id") };

      const journalMode = (
        db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined
      )?.journal_mode;
      const mem = process.memoryUsage();

      return {
        status: "ready",
        database: {
          responsive: true,
          journal_mode: journalMode ?? "unknown",
        },
        websockets: {
          active_connections: wsHub.getSubscriberCount(),
        },
        process: {
          uptime_seconds: Math.floor(process.uptime()),
          memory: {
            rss_mb: Math.round(mem.rss / 1024 / 1024),
            heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
          },
        },
        request_id: reply.getHeader("x-request-id"),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(503).send({
        status: "not_ready",
        error: message,
        request_id: reply.getHeader("x-request-id"),
      });
    }
  });

  // --- V1 ROUTES ---
  registerMembershipRoutes(app, ctx, getAuthenticatedUserId);
  if (config?.WEB_STATIC_DIR) registerStaticRoutes(app, config.WEB_STATIC_DIR);

  // Projects
  app.post("/v1/projects", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "projects:write");
    if (getAuth(req).projectId)
      throw new AppError("FORBIDDEN", "Project-bound tokens cannot create projects");
    const parsed = CreateProjectInputSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid project name or username");
    const body = parsed.data;
    const result = projectService.createProject(body.name, userId, body.username ?? "user");
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    auditService.logAction(
      userId,
      "project.create",
      result.project.project_id,
      "success",
      reqId,
      result.project.project_id,
    );
    return reply.status(201).send({ data: result, request_id: reqId });
  });

  app.get("/v1/projects/:projectId", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "projects:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);
    const project = projectService.getProject(projectId);
    return { data: project, request_id: reply.getHeader("x-request-id") };
  });

  // Sessions
  app.post("/v1/projects/:projectId/sessions", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "sessions:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);
    const parsed = JoinSessionInputSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid agent ID");
    const body = parsed.data;
    const session = sessionService.joinProject(projectId, body.agent_id, userId);
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    auditService.logAction(
      session.agent_id,
      "session.join",
      session.session_id,
      "success",
      reqId,
      projectId,
    );
    return reply.status(201).send({ data: session, request_id: reqId });
  });

  app.post("/v1/sessions/:sessionId/heartbeat", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "sessions:write");
    const parsed = SessionActionInputSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid session heartbeat");
    const body = parsed.data;
    authService.checkProjectPermission(userId, body.project_id);
    const { sessionId } = req.params as { sessionId: string };
    const session = sessionService.validateSessionForUser(sessionId, userId, body.project_id);
    if (body.agent_id !== session.agent_id) {
      throw new AppError("FORBIDDEN", "Agent does not match session");
    }
    sessionService.heartbeat(session.project_id, session.agent_id);
    auditService.logAction(
      userId,
      "session.heartbeat",
      sessionId,
      "success",
      String(reply.getHeader("x-request-id")),
      session.project_id,
    );
    return { data: { status: "ok" }, request_id: reply.getHeader("x-request-id") };
  });

  app.delete("/v1/sessions/:sessionId", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "sessions:write");
    const parsed = SessionActionInputSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid session disconnect");
    const body = parsed.data;
    authService.checkProjectPermission(userId, body.project_id);
    const { sessionId } = req.params as { sessionId: string };
    const session = sessionService.validateSessionForUser(sessionId, userId, body.project_id);
    if (body.agent_id !== session.agent_id) {
      throw new AppError("FORBIDDEN", "Agent does not match session");
    }
    sessionService.disconnect(session.project_id, session.agent_id);
    auditService.logAction(
      userId,
      "session.disconnect",
      sessionId,
      "success",
      String(reply.getHeader("x-request-id")),
      session.project_id,
    );
    wsHub.revalidate();
    return { data: { status: "disconnected" }, request_id: reply.getHeader("x-request-id") };
  });

  // Ephemeral WebSocket Ticket (Browser-safe one-time ticket)
  app.post("/v1/projects/:projectId/ws-ticket", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const body = req.body as { session_id?: string };
    if (!body?.session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to issue a WebSocket ticket");
    }

    sessionService.validateSessionForUser(body.session_id, userId, projectId);

    const ticket = wsTicketService.createTicket(
      userId,
      projectId,
      body.session_id,
      30,
      getAuth(req).tokenId,
    );
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    auditService.logAction(userId, "ws_ticket.issue", body.session_id, "success", reqId, projectId);
    return reply.status(201).send({
      data: { ticket, expires_in: 30 },
      request_id: reqId,
    });
  });

  // Inbox & Events (filtered by requesting session / agent)
  app.get("/v1/projects/:projectId/inbox", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const query = req.query as { after?: string; limit?: string; session_id?: string };
    if (!query.session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to fetch inbox events");
    }

    const session = sessionService.validateSessionForUser(query.session_id, userId, projectId);
    const requestingAgentId = session.agent_id;

    let afterSequence = 0;
    if (query.after) {
      const decoded = decodeCursor(query.after);
      if (decoded === null) {
        throw new AppError("CURSOR_INVALID", "Provided cursor is invalid or malformed");
      }
      afterSequence = decoded;
    }

    const requestedLimit = Number(query.limit ?? "50");
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      throw new AppError("INVALID_INPUT", "limit must be an integer between 1 and 100");
    }
    const limit = requestedLimit;
    // Scan in bounded batches until there is a full visible page plus lookahead.
    // Hidden messages must not strand the cursor before later visible events.
    const visibleEvents = [];
    let scanAfter = afterSequence;
    while (visibleEvents.length <= limit) {
      const batch = eventBus.getEventsAfter(projectId, scanAfter, 200);
      for (const event of batch) {
        if (isEventVisibleToAgent(event, requestingAgentId)) visibleEvents.push(event);
        if (visibleEvents.length > limit) break;
      }
      const tail = batch[batch.length - 1];
      if (!tail || batch.length < 200) break;
      scanAfter = tail.sequence;
    }

    const hasMore = visibleEvents.length > limit;
    const resultEvents = hasMore ? visibleEvents.slice(0, limit) : visibleEvents;

    const lastEvent = resultEvents[resultEvents.length - 1];
    const nextCursor = lastEvent
      ? encodeCursor(lastEvent.sequence)
      : (query.after ?? encodeCursor(0));

    return {
      data: {
        events: resultEvents,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
      request_id: reply.getHeader("x-request-id"),
    };
  });

  // Acknowledge inbox cursor for session
  app.post("/v1/projects/:projectId/inbox/ack", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const body = req.body as { session_id?: string; cursor?: string };
    if (!body?.session_id || !body?.cursor) {
      throw new AppError("INVALID_INPUT", "session_id and cursor are required");
    }
    const session = sessionService.validateSessionForUser(body.session_id, userId, projectId);

    // Validate cursor format
    const sequence = decodeCursor(body.cursor);
    if (sequence === null || sequence < 0) {
      throw new AppError("CURSOR_INVALID", "Provided cursor is invalid or malformed");
    }

    // Validate cursor does not exceed highest project sequence
    const maxSeq = eventBus.getMaxSequence(projectId);
    if (sequence > maxSeq) {
      throw new AppError(
        "CURSOR_INVALID",
        `Cursor sequence ${sequence} exceeds highest project event sequence ${maxSeq}`,
      );
    }

    // Validate that the acknowledged event is visible to this agent
    if (sequence > 0) {
      const ev = eventBus.getEventBySequence(projectId, sequence);
      if (!ev || !isEventVisibleToAgent(ev, session.agent_id)) {
        throw new AppError(
          "CURSOR_INVALID",
          `Cursor sequence ${sequence} points to an event not visible to agent '${session.agent_id}'`,
        );
      }
    }

    sessionService.updateCursor(projectId, session.agent_id, body.cursor);
    const confirmed = sessionService.getSessionById(session.session_id).last_cursor;
    return {
      data: { status: "ok", cursor: confirmed },
      request_id: reply.getHeader("x-request-id"),
    };
  });

  // Messages (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/messages", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const { session_id, idempotency_key, ...messagePayload } =
      (req.body as { session_id?: string } & Record<string, unknown>) ?? {};
    if (!session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to authenticate agent identity");
    }

    const session = sessionService.validateSessionForUser(session_id, userId, projectId);

    if (
      typeof messagePayload.body === "string" &&
      Buffer.byteLength(messagePayload.body, "utf8") > MAX_MESSAGE_BODY_BYTES
    )
      throw new AppError("MESSAGE_TOO_LARGE", "Message body exceeds 16 KiB");
    const parsed = SendMessageInputSchema.safeParse(messagePayload);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", parsed.error.errors[0]?.message ?? "Invalid message");
    }

    const message = command(
      req,
      userId,
      projectId,
      "message.create",
      { session_id, ...parsed.data },
      () => messageService.sendMessage(projectId, session.agent_id, parsed.data),
      idempotency_key,
    );
    return reply.status(201).send({ data: message, request_id: reply.getHeader("x-request-id") });
  });

  // Status Reports (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/status", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const { session_id, idempotency_key, ...statusPayload } =
      (req.body as { session_id?: string } & Record<string, unknown>) ?? {};
    if (!session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to authenticate agent identity");
    }

    const session = sessionService.validateSessionForUser(session_id, userId, projectId);

    const parsed = ReportStatusInputSchema.safeParse(statusPayload);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_INPUT",
        parsed.error.errors[0]?.message ?? "Invalid status input",
      );
    }

    const report = command(
      req,
      userId,
      projectId,
      "status.report",
      { session_id, ...parsed.data },
      () => statusService.reportStatus(projectId, session.agent_id, parsed.data),
      idempotency_key,
    );
    return reply.status(201).send({ data: report, request_id: reply.getHeader("x-request-id") });
  });

  app.get("/v1/projects/:projectId/status", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const statuses = statusService.getLatestStatuses(projectId);
    return { data: statuses, request_id: reply.getHeader("x-request-id") };
  });

  // Locks (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/locks/claim", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const { session_id, idempotency_key, ...lockPayload } =
      (req.body as { session_id?: string } & Record<string, unknown>) ?? {};
    if (!session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to authenticate agent identity");
    }

    const session = sessionService.validateSessionForUser(session_id, userId, projectId);

    const parsed = ClaimLockInputSchema.safeParse({
      ...lockPayload,
      ttl_seconds: lockPayload.ttl_seconds ?? config?.LOCK_DEFAULT_TTL_SECONDS ?? 300,
    });
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", parsed.error.errors[0]?.message ?? "Invalid lock claim");
    }

    const lock = command(
      req,
      userId,
      projectId,
      "lock.claim",
      { session_id, ...parsed.data },
      () => lockService.claimLock(projectId, session.agent_id, parsed.data),
      idempotency_key,
    );
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    auditService.logAction(
      session.agent_id,
      "lock.claim",
      lock.lock_id,
      "success",
      reqId,
      projectId,
    );
    return reply.status(201).send({ data: lock, request_id: reqId });
  });

  // Renew lock by lockId
  app.post("/v1/projects/:projectId/locks/:lockId/renew", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:write");
    const { projectId, lockId } = req.params as { projectId: string; lockId: string };
    authService.checkProjectPermission(userId, projectId);

    const body = req.body as { session_id?: string; ttl_seconds?: number };
    if (!body?.session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required");
    }

    const session = sessionService.validateSessionForUser(body.session_id, userId, projectId);
    const renewed = command(req, userId, projectId, `lock.renew:${lockId}`, body, () =>
      lockService.renewLock(
        projectId,
        session.agent_id,
        lockId,
        body.ttl_seconds === undefined
          ? (config?.LOCK_DEFAULT_TTL_SECONDS ?? 300)
          : body.ttl_seconds,
        authService.checkProjectPermission(userId, projectId) === "owner",
      ),
    );
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    auditService.logAction(session.agent_id, "lock.renew", lockId, "success", reqId, projectId);
    return { data: renewed, request_id: reqId };
  });

  // Release lock by lockId
  app.delete("/v1/projects/:projectId/locks/:lockId", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:write");
    const { projectId, lockId } = req.params as { projectId: string; lockId: string };
    authService.checkProjectPermission(userId, projectId);

    const body = req.body as { session_id?: string };
    if (!body?.session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required");
    }

    const session = sessionService.validateSessionForUser(body.session_id, userId, projectId);
    command(req, userId, projectId, `lock.release:${lockId}`, body, () => {
      lockService.releaseLockById(
        projectId,
        session.agent_id,
        lockId,
        authService.checkProjectPermission(userId, projectId) === "owner",
      );
      return { released: [lockId] };
    });
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    auditService.logAction(session.agent_id, "lock.release", lockId, "success", reqId, projectId);
    return { data: { released: [lockId] }, request_id: reqId };
  });

  app.delete("/v1/projects/:projectId/locks", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const body = req.body as { session_id?: string; paths?: string[] };
    if (!body?.session_id || !Array.isArray(body?.paths)) {
      throw new AppError("INVALID_INPUT", "session_id and paths array are required");
    }

    const session = sessionService.validateSessionForUser(body.session_id, userId, projectId);
    const released = command(req, userId, projectId, "lock.releasePaths", body, () =>
      lockService.releaseLock(
        projectId,
        session.agent_id,
        body.paths ?? [],
        authService.checkProjectPermission(userId, projectId) === "owner",
      ),
    );
    auditService.logAction(
      userId,
      "lock.releasePaths",
      session.session_id,
      "success",
      String(reply.getHeader("x-request-id")),
      projectId,
    );
    return { data: { released }, request_id: reply.getHeader("x-request-id") };
  });

  app.get("/v1/projects/:projectId/locks", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const locks = lockService.getActiveLocks(projectId);
    return { data: locks, request_id: reply.getHeader("x-request-id") };
  });

  // Team status summary
  app.get("/v1/projects/:projectId/team-status", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "projects:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const sessions = sessionService.getActiveSessions(projectId);
    const locks = lockService.getActiveLocks(projectId);
    const statuses = statusService.getLatestStatuses(projectId);

    return {
      data: {
        active_agents: sessions,
        locks,
        statuses,
      },
      request_id: reply.getHeader("x-request-id"),
    };
  });

  // WebSocket endpoint for real-time events
  void app.register(async (wsScope) => {
    wsScope.get("/v1/projects/:projectId/events", { websocket: true }, (socket, req) => {
      const params = req?.params as { projectId?: string } | undefined;
      let projectId = params?.projectId;
      if (!projectId && req?.url) {
        const match = req.url.match(/\/v1\/projects\/([^/?]+)\/events/);
        if (match?.[1]) {
          projectId = match[1];
        }
      }

      if (!projectId) {
        socket.close(1008, "Invalid project ID");
        return;
      }

      const isProduction =
        process.env.NODE_ENV === "production" || config?.NODE_ENV === "production";
      const origin = req?.headers?.origin;

      // Origin policy: in production or strict CORS, Origin header is mandatory
      if (!origin) {
        if (isProduction || !corsOrigins.includes("*")) {
          socket.close(1008, "Origin header is required");
          return;
        }
      } else if (!corsOrigins.includes(origin) && !corsOrigins.includes("*")) {
        socket.close(1008, "Invalid Origin");
        return;
      }

      // Extract ticket or query token
      let ticket: string | undefined;
      if (req?.query && typeof req.query === "object" && "ticket" in req.query) {
        ticket = String(req.query.ticket);
      } else if (req?.url) {
        try {
          const u = new URL(req.url, "http://localhost");
          if (u.searchParams.has("ticket")) {
            ticket = u.searchParams.get("ticket") ?? undefined;
          }
        } catch {
          // ignore URL parse error
        }
      }

      let queryToken: string | undefined;
      if (req?.query && typeof req.query === "object" && "token" in req.query) {
        queryToken = String(req.query.token);
      } else if (req?.url) {
        try {
          const u = new URL(req.url, "http://localhost");
          if (u.searchParams.has("token")) {
            queryToken = u.searchParams.get("token") ?? undefined;
          }
        } catch {
          // ignore URL parse error
        }
      }

      // Query string token is prohibited in production
      if (queryToken && isProduction) {
        socket.close(1008, "Token query param prohibited in production");
        return;
      }

      const authHeader = req?.headers?.authorization;
      let token = "";
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.substring(7).trim();
      } else if (!isProduction && queryToken) {
        token = queryToken;
      }

      let sessionId: string | undefined;
      if (req?.query && typeof req.query === "object" && "session_id" in req.query) {
        sessionId = String(req.query.session_id);
      } else if (req?.url) {
        try {
          const u = new URL(req.url, "http://localhost");
          if (u.searchParams.has("session_id")) {
            sessionId = u.searchParams.get("session_id") ?? undefined;
          }
        } catch {
          // ignore URL parse error
        }
      }

      try {
        if (!sessionId) {
          socket.close(1008, "session_id is required");
          return;
        }

        let authenticatedUserId = "";
        let authenticatedTokenId: string | undefined;
        if (ticket) {
          const consumed = wsTicketService.consumeTicket(ticket, projectId, sessionId);
          authenticatedUserId = consumed.userId;
          authenticatedTokenId = consumed.tokenId;
        } else if (token) {
          const verified = authService.verifyToken(token);
          requireScope(verified, "messages:read");
          authService.checkProjectPermission(verified.userId, projectId);
          authenticatedUserId = verified.userId;
          if (verified.projectId && verified.projectId !== projectId)
            throw new AppError("FORBIDDEN", "Token is bound to another project");
          authenticatedTokenId = verified.tokenId;
        } else {
          socket.close(1008, "Authentication required: missing ticket or token");
          return;
        }

        authService.checkProjectPermission(authenticatedUserId, projectId);
        if (!authenticatedTokenId || !authService.isTokenActive(authenticatedTokenId))
          throw new AppError("UNAUTHENTICATED", "Token is no longer active");
        const session = sessionService.validateSessionForUser(
          sessionId,
          authenticatedUserId,
          projectId,
        );

        const registered = wsHub.register({
          socket,
          projectId,
          userId: authenticatedUserId,
          agentId: session.agent_id,
          authorized: () => {
            try {
              authService.checkProjectPermission(authenticatedUserId, projectId);
              sessionService.validateSessionForUser(sessionId, authenticatedUserId, projectId);
              return (
                authenticatedTokenId !== undefined &&
                authService.isTokenActive(authenticatedTokenId)
              );
            } catch {
              return false;
            }
          },
        });

        if (registered)
          socket.send(JSON.stringify({ type: "connected", projectId, agentId: session.agent_id }));
      } catch {
        socket.close(1008, "Unauthorized");
      }
    });
  });

  return app as unknown as FastifyInstance & { ctx: AppContext };
}
