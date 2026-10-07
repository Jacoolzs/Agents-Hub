import type { DatabaseSync } from "node:sqlite";
import {
  AppError,
  type ClaimLockInput,
  ClaimLockInputSchema,
  type WorkspaceLock,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

function arePathsConflicting(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  // Conflict if one is parent directory/prefix of the other
  if (pathA.startsWith(`${pathB}/`) || pathB.startsWith(`${pathA}/`)) return true;
  return false;
}

export class LockService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventBus: SqliteEventBus,
  ) {}

  public claimLock(projectId: string, agentId: string, rawInput: ClaimLockInput): WorkspaceLock {
    const parsed = ClaimLockInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const err = parsed.error.errors[0]?.message ?? "Invalid lock input";
      throw new AppError("INVALID_INPUT", err);
    }
    const input = parsed.data;

    const lockId = generateId();
    const now = nowUtc();
    const ttlSeconds = input.ttl_seconds ?? 300;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    this.db.exec("BEGIN TRANSACTION;");
    try {
      // 1. Get all currently unexpired locks in this project
      const activeStmt = this.db.prepare(`
        SELECT * FROM workspace_locks
        WHERE project_id = ? AND expires_at > ?
      `);
      const activeLocks = activeStmt.all(projectId, now) as Array<{
        lock_id: string;
        project_id: string;
        owner_agent_id: string;
        paths: string;
        reason: string;
        expires_at: string;
      }>;

      // 2. Check path conflicts
      for (const active of activeLocks) {
        if (active.owner_agent_id === agentId) {
          // If owned by same agent, let it proceed or update, but check other agents
          continue;
        }

        const activePaths = JSON.parse(active.paths) as string[];
        for (const reqPath of input.paths) {
          for (const actPath of activePaths) {
            if (arePathsConflicting(reqPath, actPath)) {
              throw new AppError(
                "LOCK_CONFLICT",
                `Path '${reqPath}' conflicts with existing lock held by '${active.owner_agent_id}' on '${actPath}'`,
                crypto.randomUUID(),
                {
                  conflicting_path: reqPath,
                  held_by: active.owner_agent_id,
                  held_path: actPath,
                  expires_at: active.expires_at,
                },
              );
            }
          }
        }
      }

      // 3. Insert new lock
      this.db
        .prepare(`
        INSERT INTO workspace_locks (lock_id, project_id, owner_agent_id, paths, reason, ttl_seconds, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          lockId,
          projectId,
          agentId,
          JSON.stringify(input.paths),
          input.reason,
          ttlSeconds,
          expiresAt,
          now,
        );

      this.eventBus.recordEvent(projectId, agentId, "lock.acquired", {
        lock_id: lockId,
        paths: input.paths,
        reason: input.reason,
        expires_at: expiresAt,
      });

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }

    return {
      lock_id: lockId,
      project_id: projectId,
      owner_agent_id: agentId,
      paths: input.paths,
      reason: input.reason,
      ttl_seconds: ttlSeconds,
      expires_at: expiresAt,
      created_at: now,
    };
  }

  public releaseLock(projectId: string, agentId: string, pathsToRelease: string[]): string[] {
    const now = nowUtc();
    const activeStmt = this.db.prepare(`
      SELECT * FROM workspace_locks
      WHERE project_id = ? AND expires_at > ?
    `);
    const activeLocks = activeStmt.all(projectId, now) as Array<{
      lock_id: string;
      owner_agent_id: string;
      paths: string;
    }>;

    const released: string[] = [];

    this.db.exec("BEGIN TRANSACTION;");
    try {
      for (const lock of activeLocks) {
        const paths = JSON.parse(lock.paths) as string[];
        const remaining = paths.filter((p) => !pathsToRelease.includes(p));
        const matched = paths.filter((p) => pathsToRelease.includes(p));

        if (matched.length > 0) {
          if (lock.owner_agent_id !== agentId) {
            throw new AppError(
              "LOCK_NOT_OWNER",
              `Cannot release lock owned by agent '${lock.owner_agent_id}'`,
            );
          }

          if (remaining.length === 0) {
            // Remove entire lock
            this.db.prepare("DELETE FROM workspace_locks WHERE lock_id = ?").run(lock.lock_id);
          } else {
            // Update lock with remaining paths
            this.db
              .prepare("UPDATE workspace_locks SET paths = ? WHERE lock_id = ?")
              .run(JSON.stringify(remaining), lock.lock_id);
          }

          released.push(...matched);
        }
      }

      if (released.length > 0) {
        this.eventBus.recordEvent(projectId, agentId, "lock.released", {
          paths: released,
        });
      }

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }

    return released;
  }

  public renewLock(
    projectId: string,
    agentId: string,
    lockId: string,
    ttlSeconds = 300,
  ): WorkspaceLock {
    const now = nowUtc();
    const stmt = this.db.prepare(
      "SELECT * FROM workspace_locks WHERE lock_id = ? AND project_id = ?",
    );
    const lock = stmt.get(lockId, projectId) as
      | {
          lock_id: string;
          project_id: string;
          owner_agent_id: string;
          paths: string;
          reason: string;
          ttl_seconds: number;
          expires_at: string;
          created_at: string;
        }
      | undefined;

    if (!lock) {
      throw new AppError("PROJECT_NOT_FOUND", `Lock ${lockId} not found in project ${projectId}`);
    }

    if (lock.owner_agent_id !== agentId) {
      throw new AppError("LOCK_NOT_OWNER", `Cannot renew lock owned by '${lock.owner_agent_id}'`);
    }

    if (lock.expires_at <= now) {
      throw new AppError("LOCK_CONFLICT", `Lock ${lockId} has already expired`);
    }

    const newExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare("UPDATE workspace_locks SET expires_at = ?, ttl_seconds = ? WHERE lock_id = ?")
      .run(newExpiresAt, ttlSeconds, lockId);

    const paths = JSON.parse(lock.paths) as string[];
    this.eventBus.recordEvent(projectId, agentId, "lock.acquired", {
      lock_id: lockId,
      paths,
      reason: "renewed",
      expires_at: newExpiresAt,
    });

    return {
      lock_id: lock.lock_id,
      project_id: lock.project_id,
      owner_agent_id: lock.owner_agent_id,
      paths,
      reason: lock.reason,
      ttl_seconds: ttlSeconds,
      expires_at: newExpiresAt,
      created_at: lock.created_at,
    };
  }

  public releaseLockById(projectId: string, agentId: string, lockId: string): void {
    const stmt = this.db.prepare(
      "SELECT * FROM workspace_locks WHERE lock_id = ? AND project_id = ?",
    );
    const lock = stmt.get(lockId, projectId) as
      | {
          lock_id: string;
          owner_agent_id: string;
          paths: string;
        }
      | undefined;

    if (!lock) {
      throw new AppError("PROJECT_NOT_FOUND", `Lock ${lockId} not found`);
    }

    if (lock.owner_agent_id !== agentId) {
      throw new AppError("LOCK_NOT_OWNER", `Cannot release lock owned by '${lock.owner_agent_id}'`);
    }

    this.db.prepare("DELETE FROM workspace_locks WHERE lock_id = ?").run(lockId);

    const paths = JSON.parse(lock.paths) as string[];
    this.eventBus.recordEvent(projectId, agentId, "lock.released", {
      lock_id: lockId,
      paths,
    });
  }

  public getActiveLocks(projectId: string): WorkspaceLock[] {
    const now = nowUtc();
    const stmt = this.db.prepare(`
      SELECT * FROM workspace_locks
      WHERE project_id = ? AND expires_at > ?
      ORDER BY expires_at ASC
    `);

    const rows = stmt.all(projectId, now) as Array<{
      lock_id: string;
      project_id: string;
      owner_agent_id: string;
      paths: string;
      reason: string;
      ttl_seconds: number;
      expires_at: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      lock_id: r.lock_id,
      project_id: r.project_id,
      owner_agent_id: r.owner_agent_id,
      paths: JSON.parse(r.paths) as string[],
      reason: r.reason,
      ttl_seconds: r.ttl_seconds,
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
  }
}
