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
import { AuthService } from "./http/auth/auth-service.js";
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
        CURSOR_INVALID: 422,
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

  function getAuthenticatedUserId(req: FastifyRequest): string {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError("UNAUTHENTICATED", "Missing or malformed Authorization header");
    }
    const token = authHeader.substring(7).trim();
    const verified = authService.verifyToken(token);
    return verified.userId;
  }

  // --- HEALTH ENDPOINTS ---
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready" }));

  // --- V1 ROUTES ---

  // Projects
  app.post("/v1/projects", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
    const body = req.body as { name?: string; username?: string };
    if (!body?.name) {
      throw new AppError("INVALID_INPUT", "Project name is required");
    }
    const result = projectService.createProject(body.name, userId, body.username ?? "user");
    return reply.status(201).send({ data: result, request_id: reply.getHeader("x-request-id") });
  });

  app.get("/v1/projects/:projectId", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);
    const project = projectService.getProject(projectId);
    return { data: project, request_id: reply.getHeader("x-request-id") };
  });

  // Sessions
  app.post("/v1/projects/:projectId/sessions", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
    const body = req.body as { project_id?: string; agent_id?: string };
    if (!body?.project_id || !body?.agent_id) {
      throw new AppError("INVALID_INPUT", "project_id and agent_id are required");
    }
    authService.checkProjectPermission(userId, body.project_id);
    sessionService.heartbeat(body.project_id, body.agent_id);
    return { data: { status: "ok" }, request_id: reply.getHeader("x-request-id") };
  });

  app.delete("/v1/sessions/:sessionId", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
    const body = req.body as { project_id?: string; agent_id?: string };
    if (!body?.project_id || !body?.agent_id) {
      throw new AppError("INVALID_INPUT", "project_id and agent_id are required");
    }
    authService.checkProjectPermission(userId, body.project_id);
    sessionService.disconnect(body.project_id, body.agent_id);
    return { data: { status: "disconnected" }, request_id: reply.getHeader("x-request-id") };
  });

  // Inbox & Events (filtered by requesting session / agent)
  app.get("/v1/projects/:projectId/inbox", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const query = req.query as { after?: string; limit?: string; session_id?: string };
    let requestingAgentId: string | undefined;
    if (query.session_id) {
      const session = sessionService.validateSessionForUser(query.session_id, userId, projectId);
      requestingAgentId = session.agent_id;
    }

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
    const userId = getAuthenticatedUserId(req);
    const { projectId } = req.params as { projectId: string };
    const body = req.body as { session_id?: string; cursor?: string };
    if (!body?.session_id || !body?.cursor) {
      throw new AppError("INVALID_INPUT", "session_id and cursor are required");
    }
    const session = sessionService.validateSessionForUser(body.session_id, userId, projectId);
    sessionService.updateCursor(projectId, session.agent_id, body.cursor);
    return {
      data: { status: "ok", cursor: body.cursor },
      request_id: reply.getHeader("x-request-id"),
    };
  });

  // Messages (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/messages", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const statuses = statusService.getLatestStatuses(projectId);
    return { data: statuses, request_id: reply.getHeader("x-request-id") };
  });

  // Locks (Identity strictly derived from validated session_id)
  app.post("/v1/projects/:projectId/locks/claim", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
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
    const userId = getAuthenticatedUserId(req);
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const locks = lockService.getActiveLocks(projectId);
    return { data: locks, request_id: reply.getHeader("x-request-id") };
  });

  // Team status summary
  app.get("/v1/projects/:projectId/team-status", async (req, reply) => {
    const userId = getAuthenticatedUserId(req);
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
  app.get("/v1/projects/:projectId/events", { websocket: true }, (socket, req) => {
    const { projectId } = req.params as { projectId: string };
    const origin = req.headers.origin;

    // Validate Origin if present
    if (origin && !corsOrigins.includes(origin) && !corsOrigins.includes("*")) {
      socket.close(1008, "Invalid Origin");
      return;
    }

    const authHeader = req.headers.authorization;
    const token =
      req.query && typeof req.query === "object" && "token" in req.query
        ? String(req.query.token)
        : authHeader?.startsWith("Bearer ")
          ? authHeader.substring(7)
          : "";

    const sessionId =
      req.query && typeof req.query === "object" && "session_id" in req.query
        ? String(req.query.session_id)
        : undefined;

    try {
      if (!token) {
        socket.close(1008, "Token missing");
        return;
      }
      const verified = authService.verifyToken(token);
      authService.checkProjectPermission(verified.userId, projectId);

      let agentId: string | undefined;
      if (sessionId) {
        const session = sessionService.validateSessionForUser(
          sessionId,
          verified.userId,
          projectId,
        );
        agentId = session.agent_id;
      }

      wsHub.register({
        socket,
        projectId,
        userId: verified.userId,
        agentId,
      });

      socket.send(JSON.stringify({ type: "connected", projectId, agentId }));
    } catch {
      socket.close(1008, "Unauthorized");
    }
  });

  return app as unknown as FastifyInstance & { ctx: AppContext };
}
