import type { DatabaseSync } from "node:sqlite";
import {
  type AgentSession,
  AppError,
  decodeCursor,
  encodeCursor,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

export class SessionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventBus: SqliteEventBus,
  ) {}

  public joinProject(projectId: string, agentId: string, userId: string): AgentSession {
    return this.eventBus.transaction(() =>
      this.serializeSession(this.joinProjectCore(projectId, agentId, userId)),
    );
  }

  private joinProjectCore(projectId: string, agentId: string, userId: string): AgentSession {
    if (typeof agentId !== "string" || agentId.trim().length > 100)
      throw new AppError("INVALID_INPUT", "Invalid agent ID");
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
      if (existing.user_id !== userId) {
        throw new AppError("FORBIDDEN", "Agent name belongs to another user");
      }
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
    this.eventBus.transaction(() => this.heartbeatCore(projectId, agentId));
  }

  private heartbeatCore(projectId: string, agentId: string): void {
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
    const sequence = decodeCursor(cursor);
    if (sequence === null) throw new AppError("CURSOR_INVALID", "Invalid cursor");
    this.db
      .prepare(`
      UPDATE agent_sessions
      SET last_cursor = ?, last_sequence = ?
      WHERE project_id = ? AND agent_id = ? AND last_sequence <= ?
    `)
      .run(cursor, sequence, projectId, agentId, sequence);
  }

  public disconnect(projectId: string, agentId: string): void {
    this.eventBus.transaction(() => this.disconnectCore(projectId, agentId));
  }

  private disconnectCore(projectId: string, agentId: string): void {
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
    return this.serializeSession(row);
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
      "SELECT * FROM agent_sessions WHERE project_id = ? AND status IN ('active', 'idle')",
    );
    return (stmt.all(projectId) as unknown as AgentSession[]).map((row) =>
      this.serializeSession(row),
    );
  }

  private serializeSession(row: AgentSession): AgentSession {
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

  public expireSessions(idleSeconds = 60, disconnectSeconds = 180): number {
    const now = Date.now();
    return this.eventBus.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM agent_sessions WHERE status != 'disconnected'")
        .all() as unknown as AgentSession[];
      let changed = 0;
      for (const row of rows) {
        const age = now - Date.parse(row.last_seen_at);
        const status =
          age >= disconnectSeconds * 1000
            ? "disconnected"
            : age >= idleSeconds * 1000
              ? "idle"
              : row.status;
        if (status === row.status) continue;
        this.db
          .prepare("UPDATE agent_sessions SET status = ? WHERE session_id = ?")
          .run(status, row.session_id);
        this.eventBus.recordEvent(
          row.project_id,
          row.agent_id,
          status === "disconnected" ? "agent.left" : "agent.idle",
          { agent_id: row.agent_id },
        );
        changed++;
      }
      return changed;
    });
  }
}
