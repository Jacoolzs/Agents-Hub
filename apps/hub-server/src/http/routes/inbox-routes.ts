import { AppError, decodeCursor, encodeCursor } from "@agents-hub/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app.js";
import { isEventVisibleToAgent } from "../../application/policies/event-visibility.js";
import type { AuthContext } from "../auth/auth-service.js";

export function registerInboxRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  authenticate: (req: FastifyRequest, scope: string) => string,
  getAuth: (req: FastifyRequest) => AuthContext,
): void {
  const { authService, sessionService, eventBus, statusService, lockService } = ctx;
  function identify(req: FastifyRequest, sessionId?: string) {
    const userId = authenticate(req, "messages:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);
    if (!sessionId) throw new AppError("INVALID_INPUT", "session_id is required");
    return sessionService.validateSessionForUser(sessionId, userId, projectId);
  }

  app.get("/v1/projects/:projectId/inbox", async (req, reply) => {
    const query = req.query as { after?: string; limit?: string; session_id?: string };
    const session = identify(req, query.session_id);
    const afterSequence = query.after === undefined ? 0 : decodeCursor(query.after);
    if (afterSequence === null) throw new AppError("CURSOR_INVALID", "Invalid cursor");
    eventBus.assertCursorAvailable(session.project_id, afterSequence);
    const limit = Number(query.limit ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError("INVALID_INPUT", "limit must be an integer between 1 and 100");
    const visible = [];
    let scanAfter = afterSequence;
    while (visible.length <= limit) {
      const batch = eventBus.getEventsAfter(session.project_id, scanAfter, 200);
      for (const event of batch) {
        if (isEventVisibleToAgent(event, session.agent_id)) visible.push(event);
        if (visible.length > limit) break;
      }
      const tail = batch[batch.length - 1];
      if (!tail || batch.length < 200) break;
      scanAfter = tail.sequence;
    }
    const hasMore = visible.length > limit;
    const events = hasMore ? visible.slice(0, limit) : visible;
    const last = events[events.length - 1];
    return {
      data: {
        events,
        next_cursor: last ? encodeCursor(last.sequence) : (query.after ?? encodeCursor(0)),
        has_more: hasMore,
      },
      request_id: reply.getHeader("x-request-id"),
    };
  });

  app.get("/v1/projects/:projectId/inbox/recovery", async (req, reply) => {
    const session = identify(req, (req.query as { session_id?: string }).session_id);
    const scopes = getAuth(req).scopes ?? [];
    const allows = (scope: string) => scopes.includes("*") || scopes.includes(scope);
    // Snapshot reads and its boundary share one synchronous transaction.
    const data = eventBus.transaction(() => ({
      resume_cursor: encodeCursor(eventBus.getRetentionBoundary(session.project_id)),
      snapshot: {
        statuses: statusService.getLatestStatuses(session.project_id),
        ...(allows("projects:read")
          ? { active_agents: sessionService.getActiveSessions(session.project_id) }
          : {}),
        ...(allows("locks:read") ? { locks: lockService.getActiveLocks(session.project_id) } : {}),
      },
      warning:
        "Deleted events and messages cannot be recovered. Accept the history gap explicitly before resuming.",
    }));
    return { data, request_id: reply.getHeader("x-request-id") };
  });

  app.post("/v1/projects/:projectId/inbox/ack", async (req, reply) => {
    const body = req.body as { session_id?: string; cursor?: string; accept_history_gap?: boolean };
    const session = identify(req, body?.session_id);
    const sequence = typeof body.cursor === "string" ? decodeCursor(body.cursor) : null;
    if (sequence === null) throw new AppError("CURSOR_INVALID", "Invalid cursor");
    const data = eventBus.transaction(() => {
      const boundary = eventBus.getRetentionBoundary(session.project_id);
      const confirmed = decodeCursor(session.last_cursor ?? encodeCursor(0)) ?? 0;
      if (body.accept_history_gap !== undefined && typeof body.accept_history_gap !== "boolean")
        throw new AppError("INVALID_INPUT", "accept_history_gap must be boolean");
      if (body.accept_history_gap === true) {
        if (boundary === 0 || sequence !== boundary)
          throw new AppError(
            "CURSOR_INVALID",
            "Recovery cursor must equal the current retention boundary; refresh the snapshot",
          );
      } else if (sequence <= confirmed) {
        // Retried ACK after retention is harmless; never move a checkpoint backwards.
        return { status: "ok", cursor: session.last_cursor };
      } else {
        eventBus.assertCursorAvailable(session.project_id, sequence);
        if (confirmed < boundary) eventBus.assertCursorAvailable(session.project_id, confirmed);
        if (sequence > 0) {
          const event = eventBus.getEventBySequence(session.project_id, sequence);
          if (!event || !isEventVisibleToAgent(event, session.agent_id))
            throw new AppError(
              "CURSOR_INVALID",
              "Cursor points to an event not visible to this agent",
            );
        }
      }
      sessionService.updateCursor(session.project_id, session.agent_id, body.cursor as string);
      if (body.accept_history_gap === true)
        ctx.auditService.logAction(
          session.user_id,
          "inbox.accept_history_gap",
          session.session_id,
          "success",
          req.id,
          session.project_id,
        );
      return {
        status: "ok",
        cursor: sessionService.getSessionById(session.session_id).last_cursor,
      };
    });
    return { data, request_id: reply.getHeader("x-request-id") };
  });
}
