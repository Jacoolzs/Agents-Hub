import {
  AppError,
  MAX_MESSAGE_BODY_BYTES,
  MessageHistoryCursorSchema,
  MessageHistoryPageSchema,
  MessageHistoryQuerySchema,
  ReportStatusInputSchema,
  SendMessageInputSchema,
} from "@agents-hub/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app.js";
import type { RouteDependencies } from "./dependencies.js";

export function registerMessageRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  dependencies: RouteDependencies,
): void {
  const { messageService, statusService, sessionService, authService } = ctx;
  const { getAuthenticatedUserId, command } = dependencies;

  app.get("/v1/projects/:projectId/messages/history", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "messages:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);
    const rawQuery = req.query as Record<string, unknown>;
    if (
      rawQuery.before !== undefined &&
      !MessageHistoryCursorSchema.safeParse(rawQuery.before).success
    ) {
      throw new AppError("CURSOR_INVALID", "Invalid history cursor");
    }
    const parsed = MessageHistoryQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_INPUT",
        parsed.error.errors[0]?.message ?? "Invalid history query",
      );
    }
    const session = sessionService.validateSessionForUser(
      parsed.data.session_id,
      userId,
      projectId,
    );
    const page = MessageHistoryPageSchema.parse(
      messageService.getHistory(
        projectId,
        session.agent_id,
        parsed.data.before,
        parsed.data.channel,
        parsed.data.limit,
      ),
    );
    return { data: page, request_id: reply.getHeader("x-request-id") };
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
}
