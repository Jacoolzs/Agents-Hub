import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceLock } from "@agents-hub/shared";
import type { LockRepository } from "../../application/ports/persistence.js";

type LockRow = Omit<WorkspaceLock, "paths"> & { paths: string };
const serialize = ({ paths, ...row }: LockRow): WorkspaceLock => ({
  ...row,
  paths: JSON.parse(paths) as string[],
});

export class SqliteLockRepository implements LockRepository {
  constructor(private readonly db: DatabaseSync) {}

  public insert(lock: WorkspaceLock): void {
    this.db
      .prepare(`INSERT INTO workspace_locks (lock_id, project_id, owner_agent_id, paths, reason, ttl_seconds, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        lock.lock_id,
        lock.project_id,
        lock.owner_agent_id,
        JSON.stringify(lock.paths),
        lock.reason,
        lock.ttl_seconds,
        lock.expires_at,
        lock.created_at,
      );
  }
  public findById(projectId: string, lockId: string): WorkspaceLock | undefined {
    const row = this.db
      .prepare("SELECT * FROM workspace_locks WHERE lock_id = ? AND project_id = ?")
      .get(lockId, projectId) as LockRow | undefined;
    return row ? serialize(row) : undefined;
  }
  public activeByProject(projectId: string, now: string): WorkspaceLock[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM workspace_locks WHERE project_id = ? AND expires_at > ? ORDER BY expires_at ASC",
        )
        .all(projectId, now) as LockRow[]
    ).map(serialize);
  }
  public expired(now: string, projectId?: string): WorkspaceLock[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM workspace_locks WHERE expires_at <= ? ${projectId ? "AND project_id = ?" : ""}`,
        )
        .all(now, ...(projectId ? [projectId] : [])) as LockRow[]
    ).map(serialize);
  }
  public remove(lockId: string): void {
    this.db.prepare("DELETE FROM workspace_locks WHERE lock_id = ?").run(lockId);
  }
  public updatePaths(lockId: string, paths: string[]): void {
    this.db
      .prepare("UPDATE workspace_locks SET paths = ? WHERE lock_id = ?")
      .run(JSON.stringify(paths), lockId);
  }
  public renew(lockId: string, expiresAt: string, ttlSeconds: number): void {
    this.db
      .prepare("UPDATE workspace_locks SET expires_at = ?, ttl_seconds = ? WHERE lock_id = ?")
      .run(expiresAt, ttlSeconds, lockId);
  }
}
