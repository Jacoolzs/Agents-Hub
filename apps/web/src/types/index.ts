import type {
  AgentSession,
  EventEnvelope,
  Message,
  Project,
  StatusReport,
  WorkspaceLock,
} from "@agents-hub/shared";

export interface AuthSessionConfig {
  baseUrl: string;
  token: string;
  projectId: string;
  projectName?: string;
  sessionId: string;
  agentId: string;
  userId: string;
}

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface TeamStatusData {
  known_agents?: Array<{
    agent_id: string;
    status: "active" | "idle" | "disconnected";
    last_seen_at?: string;
  }>;
  active_agents: AgentSession[];
  locks: WorkspaceLock[];
  statuses: StatusReport[];
}

export interface InboxResponse {
  events: EventEnvelope[];
  next_cursor: string;
  has_more: boolean;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
  request_id?: string;
  details?: Record<string, unknown>;
}
