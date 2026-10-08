import {
  type AgentSession,
  AppError,
  UuidSchema,
  decodeCursor,
  encodeCursor,
  generateId,
  nowUtc,
} from "@agents-hub/shared";
import type { DomainEvents, SessionRepository } from "../ports/persistence.js";

export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly eventBus: DomainEvents,
    private readonly expireSeconds = 180,
  ) {}

  public joinProject(
    projectId: string,
    agentId: string,
    userId: string,
    instanceId?: string,
  ): AgentSession {
    if (typeof agentId !== "string" || agentId.trim().length > 100)
      throw new AppError("INVALID_INPUT", "Invalid agent ID");
    const name = agentId.trim();
    if (!name) throw new AppError("INVALID_INPUT", "Agent ID cannot be empty");
    if (instanceId !== undefined && !UuidSchema.safeParse(instanceId).success)
      throw new AppError("INVALID_INPUT", "Invalid instance ID");
    return this.eventBus.transaction(() => {
      const now = nowUtc();
      const existing = this.repository.findByAgent(projectId, name);
      let session: AgentSession;
      if (existing) {
        if (existing.user_id !== userId)
          throw new AppError("FORBIDDEN", "Agent name belongs to another user");
        const expired = this.isExpired(existing);
        if (existing.status !== "disconnected" && !expired) {
          if (instanceId && this.repository.instanceId(existing.session_id) === instanceId)
            return existing;
          throw new AppError(
            "STATE_CONFLICT",
            "El nombre de agente ya tiene una instancia conectada. Usa otro nombre, desconecta la instancia actual o espera su vencimiento.",
          );
        }
        if (existing.status !== "disconnected")
          this.eventBus.recordEvent(projectId, name, "agent.left", { agent_id: name });
        const replacementId = generateId();
        this.repository.rotateSession(existing.session_id, replacementId, now, instanceId);
        session = { ...existing, session_id: replacementId, status: "active", last_seen_at: now };
      } else {
        session = {
          session_id: generateId(),
          agent_id: name,
          project_id: projectId,
          user_id: userId,
          status: "active",
          last_seen_at: now,
          created_at: now,
          last_cursor: encodeCursor(0),
        };
        this.repository.insert(session, instanceId);
      }
      this.eventBus.recordEvent(projectId, name, "agent.joined", {
        agent_id: name,
        session_id: session.session_id,
      });
      return session;
    });
  }

  public heartbeat(projectId: string, agentId: string): void {
    this.eventBus.transaction(() => {
      if (!this.repository.updatePresence(projectId, agentId, "active", nowUtc()))
        throw new AppError(
          "SESSION_EXPIRED",
          `Agent ${agentId} is not connected to project ${projectId}`,
        );
      this.eventBus.recordEvent(projectId, agentId, "agent.heartbeat", { agent_id: agentId });
    });
  }

  public updateCursor(projectId: string, agentId: string, cursor: string): void {
    const sequence = decodeCursor(cursor);
    if (sequence === null) throw new AppError("CURSOR_INVALID", "Invalid cursor");
    this.repository.confirmCursor(projectId, agentId, cursor, sequence);
  }

  public disconnect(projectId: string, agentId: string): void {
    this.eventBus.transaction(() => {
      this.repository.updatePresence(projectId, agentId, "disconnected", nowUtc());
      this.eventBus.recordEvent(projectId, agentId, "agent.left", { agent_id: agentId });
    });
  }

  public getSessionById(sessionId: string): AgentSession {
    const session = this.repository.findById(sessionId);
    if (!session) throw new AppError("SESSION_EXPIRED", `Session ${sessionId} not found`);
    return session;
  }

  public validateSessionForUser(
    sessionId: string,
    userId: string,
    projectId: string,
  ): AgentSession {
    const session = this.getSessionById(sessionId);
    if (session.user_id !== userId)
      throw new AppError("FORBIDDEN", `Session ${sessionId} does not belong to user ${userId}`);
    if (session.project_id !== projectId)
      throw new AppError(
        "FORBIDDEN",
        `Session ${sessionId} does not belong to project ${projectId}`,
      );
    if (session.status === "disconnected" || this.isExpired(session))
      throw new AppError("SESSION_EXPIRED", `Session ${sessionId} is disconnected`);
    return session;
  }

  public getActiveSessions(projectId: string): AgentSession[] {
    return this.repository.activeByProject(projectId);
  }
  public getKnownAgents(projectId: string) {
    return this.repository.knownByProject(projectId);
  }

  private isExpired(session: AgentSession): boolean {
    return Date.now() - Date.parse(session.last_seen_at) >= this.expireSeconds * 1000;
  }

  public expireSessions(idleSeconds = 60, disconnectSeconds = 180): number {
    const now = Date.now();
    return this.eventBus.transaction(() => {
      let changed = 0;
      for (const row of this.repository.connected()) {
        const age = now - Date.parse(row.last_seen_at);
        const status =
          age >= disconnectSeconds * 1000
            ? "disconnected"
            : age >= idleSeconds * 1000
              ? "idle"
              : row.status;
        if (status === row.status) continue;
        this.repository.setStatus(row.session_id, status);
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
