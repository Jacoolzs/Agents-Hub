import {
  AppError,
  CreateProjectInputSchema,
  JoinSessionInputSchema,
  SessionActionInputSchema,
} from "@agents-hub/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app.js";
import type { RouteDependencies } from "./dependencies.js";

export function registerProjectSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  dependencies: RouteDependencies,
): void {
  const {
    projectService,
    sessionService,
    authService,
    auditService,
    wsTicketService,
    wsHub,
    lockService,
    statusService,
    eventBus,
  } = ctx;
  const { getAuthenticatedUserId, getAuth } = dependencies;

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
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    const session = eventBus.transaction(() => {
      const joined = sessionService.joinProject(projectId, body.agent_id, userId, body.instance_id);
      auditService.logAction(
        joined.agent_id,
        "session.join",
        joined.session_id,
        "success",
        reqId,
        projectId,
      );
      return joined;
    });
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
        known_agents: sessionService.getKnownAgents(projectId),
        locks,
        statuses,
      },
      request_id: reply.getHeader("x-request-id"),
    };
  });
}
