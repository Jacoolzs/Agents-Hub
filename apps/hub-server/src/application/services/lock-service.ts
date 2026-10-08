import {
  AppError,
  type ClaimLockInput,
  ClaimLockInputSchema,
  NormalizedWorkspacePathSchema,
  ReleaseLockInputSchema,
  RenewLockInputSchema,
  type WorkspaceLock,
  containsObviousSecret,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { DomainEvents, LockRepository } from "../ports/persistence.js";

function arePathsConflicting(rawA: string, rawB: string): boolean {
  const a = NormalizedWorkspacePathSchema.parse(rawA);
  const b = NormalizedWorkspacePathSchema.parse(rawB);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export class LockService {
  constructor(
    private readonly repository: LockRepository,
    private readonly eventBus: DomainEvents,
  ) {}

  public claimLock(projectId: string, agentId: string, rawInput: ClaimLockInput): WorkspaceLock {
    const parsed = ClaimLockInputSchema.safeParse(rawInput);
    if (!parsed.success)
      throw new AppError("INVALID_INPUT", parsed.error.errors[0]?.message ?? "Invalid lock input");
    const input = parsed.data;
    if (containsObviousSecret(input.reason))
      throw new AppError("INVALID_INPUT", "Remove credentials from lock reasons");
    const now = nowUtc();
    const ttl = input.ttl_seconds ?? 300;
    const lock: WorkspaceLock = {
      lock_id: generateId(),
      project_id: projectId,
      owner_agent_id: agentId,
      paths: input.paths,
      reason: input.reason,
      ttl_seconds: ttl,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      created_at: now,
    };
    return this.eventBus.transaction(() => {
      for (const active of this.repository.activeByProject(projectId, now)) {
        if (active.owner_agent_id === agentId) continue;
        for (const requested of input.paths)
          for (const held of active.paths)
            if (arePathsConflicting(requested, held))
              throw new AppError(
                "LOCK_CONFLICT",
                `Path '${requested}' conflicts with existing lock held by '${active.owner_agent_id}' on '${held}'`,
                crypto.randomUUID(),
                {
                  conflicting_path: requested,
                  held_by: active.owner_agent_id,
                  held_path: held,
                  expires_at: active.expires_at,
                },
              );
      }
      this.repository.insert(lock);
      this.eventBus.recordEvent(projectId, agentId, "lock.acquired", {
        lock_id: lock.lock_id,
        paths: lock.paths,
        reason: lock.reason,
        expires_at: lock.expires_at,
      });
      return lock;
    });
  }

  public releaseLock(
    projectId: string,
    agentId: string,
    rawPaths: string[],
    isProjectOwner = false,
  ): string[] {
    const parsed = ReleaseLockInputSchema.safeParse({ paths: rawPaths });
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid paths to release");
    return this.eventBus.transaction(() => {
      const released: string[] = [];
      for (const lock of this.repository.activeByProject(projectId, nowUtc())) {
        const paths = lock.paths.map((path) => NormalizedWorkspacePathSchema.parse(path));
        const matched = paths.filter((path) => parsed.data.paths.includes(path));
        if (!matched.length) continue;
        if (lock.owner_agent_id !== agentId && !isProjectOwner)
          throw new AppError(
            "LOCK_NOT_OWNER",
            `Cannot release lock owned by agent '${lock.owner_agent_id}'`,
          );
        const remaining = paths.filter((path) => !parsed.data.paths.includes(path));
        if (!remaining.length) this.repository.remove(lock.lock_id);
        else this.repository.updatePaths(lock.lock_id, remaining);
        released.push(...matched);
      }
      if (released.length)
        this.eventBus.recordEvent(projectId, agentId, "lock.released", { paths: released });
      return released;
    });
  }

  public renewLock(
    projectId: string,
    agentId: string,
    lockId: string,
    ttlSeconds = 300,
    isProjectOwner = false,
  ): WorkspaceLock {
    if (!RenewLockInputSchema.safeParse({ ttl_seconds: ttlSeconds }).success)
      throw new AppError("INVALID_INPUT", "TTL must be an integer between 1 and 3600");
    return this.eventBus.transaction(() => {
      const lock = this.repository.findById(projectId, lockId);
      if (!lock)
        throw new AppError("PROJECT_NOT_FOUND", `Lock ${lockId} not found in project ${projectId}`);
      if (lock.owner_agent_id !== agentId && !isProjectOwner)
        throw new AppError("LOCK_NOT_OWNER", `Cannot renew lock owned by '${lock.owner_agent_id}'`);
      if (lock.expires_at <= nowUtc())
        throw new AppError("LOCK_CONFLICT", `Lock ${lockId} has already expired`);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      this.repository.renew(lockId, expiresAt, ttlSeconds);
      this.eventBus.recordEvent(projectId, agentId, "lock.acquired", {
        lock_id: lockId,
        paths: lock.paths,
        reason: "renewed",
        expires_at: expiresAt,
      });
      return { ...lock, expires_at: expiresAt, ttl_seconds: ttlSeconds };
    });
  }

  public releaseLockById(
    projectId: string,
    agentId: string,
    lockId: string,
    isProjectOwner = false,
  ): void {
    this.eventBus.transaction(() => {
      const lock = this.repository.findById(projectId, lockId);
      if (!lock) throw new AppError("PROJECT_NOT_FOUND", `Lock ${lockId} not found`);
      if (lock.owner_agent_id !== agentId && !isProjectOwner)
        throw new AppError(
          "LOCK_NOT_OWNER",
          `Cannot release lock owned by '${lock.owner_agent_id}'`,
        );
      this.repository.remove(lockId);
      this.eventBus.recordEvent(projectId, agentId, "lock.released", {
        lock_id: lockId,
        paths: lock.paths,
      });
    });
  }

  public getActiveLocks(projectId: string): WorkspaceLock[] {
    this.expireLocks(projectId);
    return this.repository.activeByProject(projectId, nowUtc());
  }

  public expireLocks(projectId?: string): number {
    return this.eventBus.transaction(() => {
      const expired = this.repository.expired(nowUtc(), projectId);
      for (const lock of expired) {
        this.repository.remove(lock.lock_id);
        this.eventBus.recordEvent(lock.project_id, lock.owner_agent_id, "lock.expired", {
          lock_id: lock.lock_id,
          paths: lock.paths,
        });
      }
      return expired.length;
    });
  }
}
