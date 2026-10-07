import type { DatabaseSync } from "node:sqlite";
import { generateId, nowUtc } from "@agents-hub/shared";

export class AuditService {
  constructor(private readonly db: DatabaseSync) {}

  public logAction(
    actorId: string,
    action: string,
    resource: string,
    result: "success" | "failure",
    requestId: string,
    projectId?: string,
  ): void {
    const auditId = generateId();
    this.db
      .prepare(`
      INSERT INTO audit_entries (audit_id, project_id, actor_id, action, resource, result, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(auditId, projectId ?? null, actorId, action, resource, result, requestId, nowUtc());
  }
}
