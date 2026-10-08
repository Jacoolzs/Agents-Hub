import type { DatabaseSync } from "node:sqlite";
import type { StatusReport } from "@agents-hub/shared";
import type { StatusRepository } from "../../application/ports/persistence.js";

type StatusRow = Omit<StatusReport, "decision" | "blocked_by" | "next_step"> & {
  decision: string | null;
  blocked_by: string | null;
  next_step: string | null;
};

export class SqliteStatusRepository implements StatusRepository {
  constructor(private readonly db: DatabaseSync) {}

  public insert(report: StatusReport): void {
    this.db
      .prepare(`INSERT INTO status_reports (status_id, project_id, agent_id, objective, progress, decision, blocked_by, next_step, reported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        report.status_id,
        report.project_id,
        report.agent_id,
        report.objective,
        report.progress,
        report.decision ?? null,
        report.blocked_by ?? null,
        report.next_step ?? null,
        report.reported_at,
      );
  }

  public latestByProject(projectId: string): StatusReport[] {
    const rows = this.db
      .prepare(`SELECT s.* FROM status_reports s WHERE s.rowid IN (
      SELECT MAX(rowid) FROM status_reports WHERE project_id = ? GROUP BY agent_id
    )`)
      .all(projectId) as StatusRow[];
    return rows.map(({ decision, blocked_by, next_step, ...row }) => ({
      ...row,
      ...(decision ? { decision } : {}),
      ...(blocked_by ? { blocked_by } : {}),
      ...(next_step ? { next_step } : {}),
    }));
  }
}
