import type { HubClient } from "../client/hub-client.js";

export interface ToolRuntime {
  hubClient: HubClient;
  room: { projectId: string; agentId: string; sessionId: string };
  signal: AbortSignal;
  getConfirmed(): string;
  setConfirmed(cursor: string): void;
}
