import { generateId, nowUtc } from "@agents-hub/shared";
import type { AuditRepository } from "../ports/persistence.js";

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  public logAction(
    actorId: string,
    action: string,
    resource: string,
    result: "success" | "failure",
    requestId: string,
    projectId?: string,
  ): void {
    const auditId = generateId();
    this.repository.insert({
      audit_id: auditId,
      project_id: projectId,
      actor_id: actorId,
      action,
      resource,
      result,
      request_id: requestId,
      created_at: nowUtc(),
    });
  }
}
