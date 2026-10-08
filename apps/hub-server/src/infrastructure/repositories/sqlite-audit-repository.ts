import type { DatabaseSync } from "node:sqlite";
import type { AuditEntry, AuditRepository } from "../../application/ports/persistence.js";

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly db: DatabaseSync) {}

  public insert(entry: AuditEntry): void {
    this.db
      .prepare(`INSERT INTO audit_entries (audit_id, project_id, actor_id, action, resource, result, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.audit_id,
        entry.project_id ?? null,
        entry.actor_id,
        entry.action,
        entry.resource,
        entry.result,
        entry.request_id,
        entry.created_at,
      );
  }
}
