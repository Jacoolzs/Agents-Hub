import type { DatabaseSync } from "node:sqlite";
import type { EnvConfig } from "@agents-hub/config";
import {
  AppError,
  ClaimLockInputSchema,
  ReportStatusInputSchema,
  SendMessageInputSchema,
  decodeCursor,
  encodeCursor,
} from "@agents-hub/shared";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { isEventVisibleToAgent } from "./application/policies/event-visibility.js";
import { AuditService } from "./application/services/audit-service.js";
import { LockService } from "./application/services/lock-service.js";
import { MessageService } from "./application/services/message-service.js";
import { ProjectService } from "./application/services/project-service.js";
import { SessionService } from "./application/services/session-service.js";
import { StatusService } from "./application/services/status-service.js";
import { WsTicketService } from "./application/services/ws-ticket-service.js";
import { type AuthContext, AuthService } from "./http/auth/auth-service.js";
import { WebSocketHub } from "./http/websocket/ws-hub.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { SqliteEventBus } from "./infrastructure/event-bus/event-bus.js";

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
}

export function buildApp(
  config?: Partial<EnvConfig>,
  customDb?: DatabaseSync,
): FastifyInstance & { ctx: AppContext } {
  const db = customDb ?? createDatabase(config?.DATABASE_URL ?? ":memory:");
  const eventBus = new SqliteEventBus(db);
  const wsHub = new WebSocketHub();
  eventBus.subscribe((event) => wsHub.broadcast(event));

  const authService = new AuthService(db);
  const projectService = new ProjectService(db, eventBus);
  const sessionService = new SessionService(db, eventBus);
  const messageService = new MessageService(db, eventBus);
  const statusService = new StatusService(db, eventBus);
  const lockService = new LockService(db, eventBus);
  const auditService = new AuditService(db);
  const wsTicketService = new WsTicketService(db);

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
  };

  const app = fastify({
    logger: false,
    bodyLimit: 64 * 1024, // 64 KiB
  });

  // Assign ctx
  (app as unknown as { ctx: AppContext }).ctx = ctx;

  // CORS
  const corsOrigins = (config?.CORS_ORIGINS ?? "http://localhost:5173").split(",");
  void app.register(fastifyCors, {
    origin: corsOrigins,
    credentials: true,
  });

  // WebSocket
  void app.register(fastifyWebsocket);

  // Hook to handle requestId and error formatting
  app.addHook("onRequest", async (req, reply) => {
    const reqId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    reply.header("x-request-id", reqId);
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
      };
      const statusCode = statusMap[error.code] ?? 500;
      return reply.status(statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
          ...(error.details ? { details: error.details } : {}),
        },
        request_id: requestId,
      });
    }

    const err = error as { statusCode?: number; message?: string };
    return reply.status(err.statusCode ?? 500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "An unexpected error occurred",
        request_id: requestId,
      },
      request_id: requestId,
    });
  });

  function getAuth(req: FastifyRequest): AuthContext {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("UNAUTHENTICATED", "Missing or malformed Authorization header");
    }
    const token = authHeader.substring(7).trim();
    return authService.verifyToken(token);
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
    return auth.userId;
  }

  // --- HEALTH ENDPOINTS ---
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready" }));

  // --- V1 ROUTES ---

  // Projects
  app.post("/v1/projects", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "projects:write");
    const body = req.body as { name?: string; username?: string };
    if (!body?.name) {
      throw new AppError("INVALID_INPUT", "Project name is required");
    }
    const result = projectService.createProject(body.name, userId, body.username ?? "user");
    return reply.status(201).send({ data: result, request_id: reply.getHeader("x-request-id") });
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
    const body = req.body as { agent_id?: string };
    if (!body?.agent_id) {
      throw new AppError("INVALID_INPUT", "agent_id is required");
    }
    const session = sessionService.joinProject(projectId, body.agent_id, userId);
    return reply.status(201).send({ data: session, request_id: reply.getHeader("x-request-id") });
  });

  app.post("/v1/sessions/:sessionId/heartbeat", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "sessions:write");
    const body = req.body as { project_id?: string; agent_id?: string };
    if (!body?.project_id || !body?.agent_id) {
      throw new AppError("INVALID_INPUT", "project_id and agent_id are required");
    }
    authService.checkProjectPermission(userId, body.project_id);
    sessionService.heartbeat(body.project_id, body.agent_id);
    return { data: { status: "ok" }, request_id: reply.getHeader("x-request-id") };
  });

  app.delete("/v1/sessions/:sessionId", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "sessions:write");
    const body = req.body as { project_id?: string; agent_id?: string };
    if (!body?.project_id || !body?.agent_id) {
      throw new AppError("INVALID_INPUT", "project_id and agent_id are required");
    }
    authService.checkProjectPermission(userId, body.project_id);
    sessionService.disconnect(body.project_id, body.agent_id);
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

    const ticket = wsTicketService.createTicket(userId, projectId, body.session_id, 30);
    return reply.status(201).send({
      data: { ticket, expires_in: 30 },
      request_id: reply.getHeader("x-request-id"),
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

    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "50", 10), 1), 100);
    // Fetch events and filter by agent visibility
    const rawEvents = eventBus.getEventsAfter(projectId, afterSequence, limit * 2);
    const visibleEvents = rawEvents.filter((ev) => isEventVisibleToAgent(ev, requestingAgentId));

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
      if (ev && !isEventVisibleToAgent(ev, session.agent_id)) {
        throw new AppError(
          "CURSOR_INVALID",
          `Cursor sequence ${sequence} points to an event not visible to agent '${session.agent_id}'`,
        );
      }
    }

    sessionService.updateCursor(projectId, session.agent_id, body.cursor);
    return {
      data: { status: "ok", cursor: body.cursor },
      request_id: reply.getHeader("x-request-id"),
    };
  });

  // Messages (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/messages", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const { session_id, ...messagePayload } =
      (req.body as { session_id?: string } & Record<string, unknown>) ?? {};
    if (!session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to authenticate agent identity");
    }

    const session = sessionService.validateSessionForUser(session_id, userId, projectId);

    const parsed = SendMessageInputSchema.safeParse(messagePayload);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", parsed.error.errors[0]?.message ?? "Invalid message");
    }

    const message = messageService.sendMessage(projectId, session.agent_id, parsed.data);
    return reply.status(201).send({ data: message, request_id: reply.getHeader("x-request-id") });
  });

  // Status Reports (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/status", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:write");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const { session_id, ...statusPayload } =
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

    const report = statusService.reportStatus(projectId, session.agent_id, parsed.data);
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

    const { session_id, ...lockPayload } =
      (req.body as { session_id?: string } & Record<string, unknown>) ?? {};
    if (!session_id) {
      throw new AppError("INVALID_INPUT", "session_id is required to authenticate agent identity");
    }

    const session = sessionService.validateSessionForUser(session_id, userId, projectId);

    const parsed = ClaimLockInputSchema.safeParse(lockPayload);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", parsed.error.errors[0]?.message ?? "Invalid lock claim");
    }

    const lock = lockService.claimLock(projectId, session.agent_id, parsed.data);
    return reply.status(201).send({ data: lock, request_id: reply.getHeader("x-request-id") });
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
    const renewed = lockService.renewLock(projectId, session.agent_id, lockId, body.ttl_seconds);
    return { data: renewed, request_id: reply.getHeader("x-request-id") };
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
    lockService.releaseLockById(projectId, session.agent_id, lockId);
    return { data: { released: [lockId] }, request_id: reply.getHeader("x-request-id") };
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
    const released = lockService.releaseLock(projectId, session.agent_id, body.paths);
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
        if (ticket) {
          const consumed = wsTicketService.consumeTicket(ticket, projectId, sessionId);
          authenticatedUserId = consumed.userId;
        } else if (token) {
          const verified = authService.verifyToken(token);
          requireScope(verified, "messages:read");
          authService.checkProjectPermission(verified.userId, projectId);
          authenticatedUserId = verified.userId;
        } else {
          socket.close(1008, "Authentication required: missing ticket or token");
          return;
        }

        const session = sessionService.validateSessionForUser(
          sessionId,
          authenticatedUserId,
          projectId,
        );

        wsHub.register({
          socket,
          projectId,
          userId: authenticatedUserId,
          agentId: session.agent_id,
        });

        socket.send(JSON.stringify({ type: "connected", projectId, agentId: session.agent_id }));
      } catch {
        socket.close(1008, "Unauthorized");
      }
    });
  });

  return app as unknown as FastifyInstance & { ctx: AppContext };
}
