import type { DatabaseSync } from "node:sqlite";
import {
  AppError,
  type ReportStatusInput,
  ReportStatusInputSchema,
  type StatusReport,
  containsObviousSecret,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

export class StatusService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventBus: SqliteEventBus,
  ) {}

  public reportStatus(
    projectId: string,
    agentId: string,
    rawInput: ReportStatusInput,
  ): StatusReport {
    const parsed = ReportStatusInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const err = parsed.error.errors[0]?.message ?? "Invalid status input";
      throw new AppError("INVALID_INPUT", err);
    }
    const input = parsed.data;
    if (
      Object.values(input).some(
        (value) => typeof value === "string" && containsObviousSecret(value),
      )
    )
      throw new AppError("INVALID_INPUT", "Remove credentials from status reports");

    const statusId = generateId();
    const now = nowUtc();

    return this.eventBus.transaction(() => {
      this.db
        .prepare(`
        INSERT INTO status_reports (status_id, project_id, agent_id, objective, progress, decision, blocked_by, next_step, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          statusId,
          projectId,
          agentId,
          input.objective,
          input.progress,
          input.decision ?? null,
          input.blocked_by ?? null,
          input.next_step ?? null,
          now,
        );

      this.eventBus.recordEvent(projectId, agentId, "status.updated", {
        status_id: statusId,
        agent_id: agentId,
        objective: input.objective,
        progress: input.progress,
        decision: input.decision ?? null,
        blocked_by: input.blocked_by ?? null,
        next_step: input.next_step ?? null,
      });

      return {
        status_id: statusId,
        project_id: projectId,
        agent_id: agentId,
        objective: input.objective,
        progress: input.progress,
        ...(input.decision ? { decision: input.decision } : {}),
        ...(input.blocked_by ? { blocked_by: input.blocked_by } : {}),
        ...(input.next_step ? { next_step: input.next_step } : {}),
        reported_at: now,
      };
    });
  }

  public getLatestStatuses(projectId: string): StatusReport[] {
    // Get latest report per agent ordered by reported_at DESC
    const stmt = this.db.prepare(`
      SELECT s.*
      FROM status_reports s
      WHERE s.rowid IN (
        SELECT MAX(rowid)
        FROM status_reports
        WHERE project_id = ?
        GROUP BY agent_id
      )
    `);

    const rows = stmt.all(projectId) as Array<{
      status_id: string;
      project_id: string;
      agent_id: string;
      objective: string;
      progress: StatusReport["progress"];
      decision: string | null;
      blocked_by: string | null;
      next_step: string | null;
      reported_at: string;
    }>;

    return rows.map((r) => ({
      status_id: r.status_id,
      project_id: r.project_id,
      agent_id: r.agent_id,
      objective: r.objective,
      progress: r.progress,
      ...(r.decision ? { decision: r.decision } : {}),
      ...(r.blocked_by ? { blocked_by: r.blocked_by } : {}),
      ...(r.next_step ? { next_step: r.next_step } : {}),
      reported_at: r.reported_at,
    }));
  }
}
