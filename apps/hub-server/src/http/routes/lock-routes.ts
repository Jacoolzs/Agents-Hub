import {
  AppError,
  ClaimLockInputSchema,
  RenewLockInputSchema,
  UuidSchema,
  WorkspaceLockSchema,
} from "@agents-hub/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app.js";
import type { RouteDependencies } from "./dependencies.js";

export function registerLockRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  dependencies: RouteDependencies,
): void {
  const { lockService, sessionService, authService } = ctx;
  const { getAuthenticatedUserId, command, config } = dependencies;

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
    return reply.status(201).send({ data: lock, request_id: reqId });
  });

  // Renew lock by lockId
  app.post("/v1/projects/:projectId/locks/:lockId/renew", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:write");
    const { projectId, lockId } = req.params as { projectId: string; lockId: string };
    const role = authService.checkProjectPermission(userId, projectId);
    if (!UuidSchema.safeParse(lockId).success)
      throw new AppError("INVALID_INPUT", "lockId must be a UUID");

    const { session_id, idempotency_key, ...renewPayload } =
      (req.body as { session_id?: string; idempotency_key?: unknown } & Record<string, unknown>) ??
      {};
    if (typeof session_id !== "string" || !UuidSchema.safeParse(session_id).success) {
      throw new AppError("INVALID_INPUT", "session_id is required");
    }

    const parsed = RenewLockInputSchema.safeParse({
      ...renewPayload,
      ttl_seconds:
        renewPayload.ttl_seconds === undefined
          ? (config?.LOCK_DEFAULT_TTL_SECONDS ?? 300)
          : renewPayload.ttl_seconds,
    });
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        parsed.error.errors[0]?.message ?? "Invalid lock renewal",
      );
    const session = sessionService.validateSessionForUser(session_id, userId, projectId);
    const renewed = command(
      req,
      userId,
      projectId,
      `lock.renew:${lockId}`,
      { session_id, ...renewPayload },
      () =>
        lockService.renewLock(
          projectId,
          session.agent_id,
          lockId,
          parsed.data.ttl_seconds,
          role === "owner",
        ),
      idempotency_key,
    );
    const reqId = (reply.getHeader("x-request-id") as string) || crypto.randomUUID();
    return { data: WorkspaceLockSchema.parse(renewed), request_id: reqId };
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
    return { data: { released }, request_id: reply.getHeader("x-request-id") };
  });

  app.get("/v1/projects/:projectId/locks", async (req, reply) => {
    const userId = getAuthenticatedUserId(req, "locks:read");
    const { projectId } = req.params as { projectId: string };
    authService.checkProjectPermission(userId, projectId);

    const locks = lockService.getActiveLocks(projectId);
    return { data: locks, request_id: reply.getHeader("x-request-id") };
  });
}
