import {
  AppError,
  type ReportStatusInput,
  ReportStatusInputSchema,
  type StatusReport,
  containsObviousSecret,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { DomainEvents, StatusRepository } from "../ports/persistence.js";

export class StatusService {
  constructor(
    private readonly repository: StatusRepository,
    private readonly eventBus: DomainEvents,
  ) {}

  public reportStatus(
    projectId: string,
    agentId: string,
    rawInput: ReportStatusInput,
  ): StatusReport {
    const parsed = ReportStatusInputSchema.safeParse(rawInput);
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        parsed.error.errors[0]?.message ?? "Invalid status input",
      );
    const input = parsed.data;
    if (
      Object.values(input).some(
        (value) => typeof value === "string" && containsObviousSecret(value),
      )
    )
      throw new AppError("INVALID_INPUT", "Remove credentials from status reports");
    const report: StatusReport = {
      status_id: generateId(),
      project_id: projectId,
      agent_id: agentId,
      objective: input.objective,
      progress: input.progress,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.blocked_by ? { blocked_by: input.blocked_by } : {}),
      ...(input.next_step ? { next_step: input.next_step } : {}),
      reported_at: nowUtc(),
    };
    return this.eventBus.transaction(() => {
      this.repository.insert(report);
      this.eventBus.recordEvent(projectId, agentId, "status.updated", {
        status_id: report.status_id,
        agent_id: agentId,
        objective: input.objective,
        progress: input.progress,
        decision: input.decision ?? null,
        blocked_by: input.blocked_by ?? null,
        next_step: input.next_step ?? null,
      });
      return report;
    });
  }

  public getLatestStatuses(projectId: string): StatusReport[] {
    return this.repository.latestByProject(projectId);
  }
}
