import type { DatabaseSync } from "node:sqlite";
import { type AgentSession, type AgentSessionStatus, encodeCursor } from "@agents-hub/shared";
import type { SessionRepository } from "../../application/ports/persistence.js";

function serialize(row: AgentSession): AgentSession {
  return {
    session_id: row.session_id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    user_id: row.user_id,
    status: row.status,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    last_cursor: row.last_cursor || encodeCursor(0),
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  public findByAgent(projectId: string, agentId: string): AgentSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_sessions WHERE project_id = ? AND agent_id = ?")
      .get(projectId, agentId) as AgentSession | undefined;
    return row ? serialize(row) : undefined;
  }
  public findById(sessionId: string): AgentSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as AgentSession | undefined;
    return row ? serialize(row) : undefined;
  }
  public insert(session: AgentSession, instanceId?: string): void {
    this.db
      .prepare(`INSERT INTO agent_sessions (session_id, agent_id, project_id, user_id, status, last_seen_at, created_at, instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        session.session_id,
        session.agent_id,
        session.project_id,
        session.user_id,
        session.status,
        session.last_seen_at,
        session.created_at,
        instanceId ?? null,
      );
  }
  public instanceId(sessionId: string): string | undefined {
    const row = this.db
      .prepare("SELECT instance_id FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as { instance_id: string | null } | undefined;
    return row?.instance_id ?? undefined;
  }
  public rotateSession(
    sessionId: string,
    replacementId: string,
    seenAt: string,
    instanceId?: string,
  ): void {
    // Called inside the shared unit of work; clear ephemeral FK references first.
    this.db.prepare("DELETE FROM ws_tickets WHERE session_id = ?").run(sessionId);
    this.db
      .prepare(
        "UPDATE agent_sessions SET session_id = ?, instance_id = ?, status = 'active', last_seen_at = ? WHERE session_id = ?",
      )
      .run(replacementId, instanceId ?? null, seenAt, sessionId);
  }
  public updatePresence(
    projectId: string,
    agentId: string,
    status: AgentSessionStatus,
    seenAt: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE agent_sessions SET status = ?, last_seen_at = ? WHERE project_id = ? AND agent_id = ?",
        )
        .run(status, seenAt, projectId, agentId).changes > 0
    );
  }
  public confirmCursor(projectId: string, agentId: string, cursor: string, sequence: number): void {
    this.db
      .prepare(
        "UPDATE agent_sessions SET last_cursor = ?, last_sequence = ? WHERE project_id = ? AND agent_id = ? AND last_sequence <= ?",
      )
      .run(cursor, sequence, projectId, agentId, sequence);
  }
  public activeByProject(projectId: string): AgentSession[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM agent_sessions WHERE project_id = ? AND status IN ('active', 'idle')",
        )
        .all(projectId) as unknown as AgentSession[]
    ).map(serialize);
  }
  public connected(): AgentSession[] {
    return (
      this.db
        .prepare("SELECT * FROM agent_sessions WHERE status != 'disconnected'")
        .all() as unknown as AgentSession[]
    ).map(serialize);
  }
  public setStatus(sessionId: string, status: AgentSessionStatus): void {
    this.db
      .prepare("UPDATE agent_sessions SET status = ? WHERE session_id = ?")
      .run(status, sessionId);
  }
}
