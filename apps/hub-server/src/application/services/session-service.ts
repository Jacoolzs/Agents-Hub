import type { DatabaseSync } from "node:sqlite";
import { type AgentSession, AppError, generateId, nowUtc } from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

export class SessionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventBus: SqliteEventBus,
  ) {}

  public joinProject(projectId: string, agentId: string, userId: string): AgentSession {
    const trimmedAgentId = agentId.trim();
    if (!trimmedAgentId) {
      throw new AppError("INVALID_INPUT", "Agent ID cannot be empty");
    }

    const now = nowUtc();
    const existingStmt = this.db.prepare(
      "SELECT * FROM agent_sessions WHERE project_id = ? AND agent_id = ?",
    );
    const existing = existingStmt.get(projectId, trimmedAgentId) as AgentSession | undefined;

    if (existing) {
      this.db
        .prepare(`
        UPDATE agent_sessions
        SET status = 'active', last_seen_at = ?
        WHERE session_id = ?
      `)
        .run(now, existing.session_id);

      this.eventBus.recordEvent(projectId, trimmedAgentId, "agent.joined", {
        agent_id: trimmedAgentId,
        session_id: existing.session_id,
      });

      return {
        ...existing,
        status: "active",
        last_seen_at: now,
      };
    }

    const sessionId = generateId();
    this.db
      .prepare(`
      INSERT INTO agent_sessions (session_id, agent_id, project_id, user_id, status, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `)
      .run(sessionId, trimmedAgentId, projectId, userId, now, now);

    this.eventBus.recordEvent(projectId, trimmedAgentId, "agent.joined", {
      agent_id: trimmedAgentId,
      session_id: sessionId,
    });

    return {
      session_id: sessionId,
      agent_id: trimmedAgentId,
      project_id: projectId,
      user_id: userId,
      status: "active",
      last_seen_at: now,
      created_at: now,
    };
  }

  public heartbeat(projectId: string, agentId: string): void {
    const now = nowUtc();
    const result = this.db
      .prepare(`
      UPDATE agent_sessions
      SET last_seen_at = ?, status = 'active'
      WHERE project_id = ? AND agent_id = ?
    `)
      .run(now, projectId, agentId);

    if (result.changes === 0) {
      throw new AppError(
        "SESSION_EXPIRED",
        `Agent ${agentId} is not connected to project ${projectId}`,
      );
    }

    this.eventBus.recordEvent(projectId, agentId, "agent.heartbeat", { agent_id: agentId });
  }

  public updateCursor(projectId: string, agentId: string, cursor: string): void {
    this.db
      .prepare(`
      UPDATE agent_sessions
      SET last_cursor = ?
      WHERE project_id = ? AND agent_id = ?
    `)
      .run(cursor, projectId, agentId);
  }

  public disconnect(projectId: string, agentId: string): void {
    const now = nowUtc();
    this.db
      .prepare(`
      UPDATE agent_sessions
      SET status = 'disconnected', last_seen_at = ?
      WHERE project_id = ? AND agent_id = ?
    `)
      .run(now, projectId, agentId);

    this.eventBus.recordEvent(projectId, agentId, "agent.left", { agent_id: agentId });
  }

  public getSessionById(sessionId: string): AgentSession {
    const stmt = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?");
    const row = stmt.get(sessionId) as AgentSession | undefined;
    if (!row) {
      throw new AppError("SESSION_EXPIRED", `Session ${sessionId} not found`);
    }
    return row;
  }

  public validateSessionForUser(
    sessionId: string,
    userId: string,
    projectId: string,
  ): AgentSession {
    const session = this.getSessionById(sessionId);
    if (session.user_id !== userId) {
      throw new AppError("FORBIDDEN", `Session ${sessionId} does not belong to user ${userId}`);
    }
    if (session.project_id !== projectId) {
      throw new AppError(
        "FORBIDDEN",
        `Session ${sessionId} does not belong to project ${projectId}`,
      );
    }
    if (session.status === "disconnected") {
      throw new AppError("SESSION_EXPIRED", `Session ${sessionId} is disconnected`);
    }
    return session;
  }

  public getActiveSessions(projectId: string): AgentSession[] {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_sessions WHERE project_id = ? AND status = 'active'",
    );
    return stmt.all(projectId) as unknown as AgentSession[];
  }
}
