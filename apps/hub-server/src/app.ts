import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvConfig } from "@agents-hub/config";
import {
  AppError,
  ClaimLockInputSchema,
  CreateProjectInputSchema,
  HubCapabilitiesSchema,
  JoinSessionInputSchema,
  MAX_MESSAGE_BODY_BYTES,
  ReportStatusInputSchema,
  SendMessageInputSchema,
  SessionActionInputSchema,
  UuidSchema,
} from "@agents-hub/shared";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
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
import { registerEventRoutes } from "./http/routes/event-routes.js";
import { registerInboxRoutes } from "./http/routes/inbox-routes.js";
import { registerLockRoutes } from "./http/routes/lock-routes.js";
import { registerMembershipRoutes } from "./http/routes/membership-routes.js";
import { registerMessageRoutes } from "./http/routes/message-routes.js";
import { registerProjectSessionRoutes } from "./http/routes/project-session-routes.js";
import { registerStaticRoutes } from "./http/routes/static-routes.js";
import { WebSocketHub } from "./http/websocket/ws-hub.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { SqliteEventBus } from "./infrastructure/event-bus/event-bus.js";
import { SqliteAuditRepository } from "./infrastructure/repositories/sqlite-audit-repository.js";
import { SqliteIdempotencyRepository } from "./infrastructure/repositories/sqlite-idempotency-repository.js";
import { SqliteLockRepository } from "./infrastructure/repositories/sqlite-lock-repository.js";
import { SqliteMembershipRepository } from "./infrastructure/repositories/sqlite-membership-repository.js";
import { SqliteMessageRepository } from "./infrastructure/repositories/sqlite-message-repository.js";
import { SqliteProjectRepository } from "./infrastructure/repositories/sqlite-project-repository.js";
import { SqliteSessionRepository } from "./infrastructure/repositories/sqlite-session-repository.js";
import { SqliteStatusRepository } from "./infrastructure/repositories/sqlite-status-repository.js";
import { SqliteTicketRepository } from "./infrastructure/repositories/sqlite-ticket-repository.js";
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
  const projectService = new ProjectService(new SqliteProjectRepository(db), eventBus);
  const sessionService = new SessionService(
    new SqliteSessionRepository(db),
    eventBus,
    config?.SESSION_EXPIRE_SECONDS,
  );
  const messageService = new MessageService(new SqliteMessageRepository(db), eventBus);
  const statusService = new StatusService(new SqliteStatusRepository(db), eventBus);
  const lockService = new LockService(new SqliteLockRepository(db), eventBus);
  const auditService = new AuditService(new SqliteAuditRepository(db));
  const wsTicketService = new WsTicketService(new SqliteTicketRepository(db));
  const membershipService = new MembershipService(
    new SqliteMembershipRepository(db),
    eventBus,
    authService,
    auditService,
  );
  const idempotencyService = new IdempotencyService(new SqliteIdempotencyRepository(db), eventBus);
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
          eventBus.pruneEventsBefore(before);
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
        CURSOR_EXPIRED: 410,
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
    const idempotencyKey = bodyKey ?? req.headers["idempotency-key"];
    let commandPayload = payload;
    if (
      idempotencyKey !== undefined &&
      payload &&
      typeof payload === "object" &&
      "session_id" in payload &&
      typeof payload.session_id === "string"
    ) {
      const session = sessionService.validateSessionForUser(payload.session_id, userId, projectId);
      const { session_id: _sessionId, ...domainPayload } = payload;
      commandPayload = { ...domainPayload, actor_agent_id: session.agent_id };
    }
    return idempotencyService.execute(
      userId,
      projectId,
      operation,
      idempotencyKey,
      commandPayload,
      () =>
        eventBus.transaction(() => {
          const result = fn();
          if (
            operation === "message.create" ||
            operation === "status.report" ||
            operation.startsWith("lock.")
          ) {
            const entity = result as { message_id?: string; status_id?: string; lock_id?: string };
            const [action, lockId] = operation.split(":");
            auditService.logAction(
              userId,
              action ?? operation,
              entity.message_id ??
                entity.status_id ??
                entity.lock_id ??
                lockId ??
                (payload as { session_id?: string }).session_id ??
                projectId,
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
  app.get("/v1/capabilities", async (_req, reply) => ({
    data: HubCapabilitiesSchema.parse({
      api_version: "v1",
      contract_revision: 1,
      features: [
        "exclusive_instances",
        "cursor_recovery",
        "explicit_ack",
        "idempotent_commands",
        "message_history",
        "explicit_lock_renewal",
      ],
    }),
    request_id: reply.getHeader("x-request-id"),
  }));
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

  const dependencies = {
    config,
    corsOrigins,
    getAuthenticatedUserId,
    getAuth,
    requireScope,
    command,
  };
  registerProjectSessionRoutes(app, ctx, dependencies);

  registerInboxRoutes(app, ctx, getAuthenticatedUserId, getAuth);

  registerMessageRoutes(app, ctx, dependencies);

  registerLockRoutes(app, ctx, dependencies);

  registerEventRoutes(app, ctx, dependencies);

  return app as unknown as FastifyInstance & { ctx: AppContext };
}
