import type {
  AgentSession,
  Membership,
  Message,
  MessageHistoryPage,
  Project,
  StatusReport,
  WorkspaceLock,
} from "@agents-hub/shared";
import {
  type InboxRecovery,
  InboxRecoverySchema,
  MessageHistoryPageSchema,
} from "@agents-hub/shared";
import type { InboxResponse, TeamStatusData } from "../types/index.js";

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly requestId?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const requestId = res.headers.get("x-request-id") ?? undefined;
  if (!res.ok) {
    let errCode = "INTERNAL_ERROR";
    let errMsg = `Request failed with status ${res.status}`;
    let details: Record<string, unknown> | undefined;

    try {
      const json = await res.json();
      if (json && typeof json === "object" && "error" in json) {
        errCode = json.error.code || errCode;
        errMsg = json.error.message || errMsg;
        details = json.error.details;
      }
    } catch {
      // response wasn't JSON
    }

    throw new ApiClientError(errCode, errMsg, res.status, requestId, details);
  }

  const json = await res.json();
  return (json?.data !== undefined ? json.data : json) as T;
}

function makeHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-request-id": crypto.randomUUID(),
  };
}

export async function heartbeatSession(
  baseUrl: string,
  token: string,
  sessionId: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  await handleResponse(
    await fetch(`${baseUrl}/v1/sessions/${sessionId}/heartbeat`, {
      method: "POST",
      headers: makeHeaders(token),
      body: JSON.stringify({ project_id: projectId, agent_id: agentId }),
      signal: AbortSignal.timeout(10000),
    }),
  );
}
export async function disconnectSession(
  baseUrl: string,
  token: string,
  sessionId: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  await handleResponse(
    await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: makeHeaders(token),
      body: JSON.stringify({ project_id: projectId, agent_id: agentId }),
      keepalive: true,
      signal: AbortSignal.timeout(3000),
    }),
  );
}
export async function membershipRequest<T>(
  baseUrl: string,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return handleResponse<T>(
    await fetch(`${baseUrl}${path}`, {
      method,
      headers: makeHeaders(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export async function fetchProject(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<Project> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: makeHeaders(token),
  });
  return handleResponse<Project>(res);
}

export async function createProject(
  baseUrl: string,
  token: string,
  name: string,
  username?: string,
): Promise<{ project: Project; membership: Membership }> {
  const res = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({ name, username }),
  });
  return handleResponse<{ project: Project; membership: Membership }>(res);
}

export async function joinSession(
  baseUrl: string,
  token: string,
  projectId: string,
  agentId: string,
  instanceId = crypto.randomUUID(),
): Promise<AgentSession> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({ agent_id: agentId, instance_id: instanceId }),
  });
  return handleResponse<AgentSession>(res);
}

export async function createWsTicket(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
): Promise<{ ticket: string; expires_in: number }> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/ws-ticket`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({ session_id: sessionId }),
  });
  return handleResponse<{ ticket: string; expires_in: number }>(res);
}

export async function fetchInbox(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  afterCursor?: string,
  limit = 50,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  params.set("session_id", sessionId);
  params.set("limit", String(limit));
  if (afterCursor) {
    params.set("after", afterCursor);
  }

  const res = await fetch(
    `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/inbox?${params.toString()}`,
    {
      headers: makeHeaders(token),
    },
  );
  return handleResponse<InboxResponse>(res);
}

export async function ackInbox(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  cursor: string,
  acceptHistoryGap = false,
): Promise<{ status: string; cursor: string }> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/inbox/ack`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({
      session_id: sessionId,
      cursor,
      ...(acceptHistoryGap ? { accept_history_gap: true } : {}),
    }),
  });
  return handleResponse<{ status: string; cursor: string }>(res);
}

export async function fetchInboxRecovery(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
): Promise<InboxRecovery> {
  const data = await membershipRequest<unknown>(
    baseUrl,
    token,
    `/v1/projects/${encodeURIComponent(projectId)}/inbox/recovery?session_id=${encodeURIComponent(sessionId)}`,
  );
  return InboxRecoverySchema.parse(data);
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  payload: {
    channel: string;
    body: string;
    recipient_agent_ids?: string[] | undefined;
    priority?: ("low" | "normal" | "high" | "urgent") | undefined;
    correlation_id?: string | undefined;
  },
): Promise<Message> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/messages`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({
      session_id: sessionId,
      ...payload,
    }),
  });
  return handleResponse<Message>(res);
}

export async function fetchMessageHistory(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  before?: string,
  limit = 50,
  channel?: string,
): Promise<MessageHistoryPage> {
  const params = new URLSearchParams({ session_id: sessionId, limit: String(limit) });
  if (before) params.set("before", before);
  if (channel) params.set("channel", channel);
  const res = await fetch(
    `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/messages/history?${params.toString()}`,
    { headers: makeHeaders(token) },
  );
  return MessageHistoryPageSchema.parse(await handleResponse<unknown>(res));
}

export async function reportStatus(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  payload: {
    objective: string;
    progress: "started" | "in_progress" | "blocked" | "completed";
    decision?: string | undefined;
    blocked_by?: string | undefined;
    next_step?: string | undefined;
  },
): Promise<StatusReport> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/status`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({
      session_id: sessionId,
      ...payload,
    }),
  });
  return handleResponse<StatusReport>(res);
}

export async function fetchStatuses(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<StatusReport[]> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/status`, {
    headers: makeHeaders(token),
  });
  return handleResponse<StatusReport[]>(res);
}

export async function claimLock(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  payload: {
    paths: string[];
    reason: string;
    ttl_seconds?: number | undefined;
  },
): Promise<WorkspaceLock> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/locks/claim`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify({
      session_id: sessionId,
      ...payload,
    }),
  });
  return handleResponse<WorkspaceLock>(res);
}

export async function releaseLock(
  baseUrl: string,
  token: string,
  projectId: string,
  sessionId: string,
  lockId: string,
): Promise<{ released: string[] }> {
  const res = await fetch(
    `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/locks/${encodeURIComponent(lockId)}`,
    {
      method: "DELETE",
      headers: makeHeaders(token),
      body: JSON.stringify({ session_id: sessionId }),
    },
  );
  return handleResponse<{ released: string[] }>(res);
}

export async function fetchLocks(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<WorkspaceLock[]> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/locks`, {
    headers: makeHeaders(token),
  });
  return handleResponse<WorkspaceLock[]>(res);
}

export async function fetchTeamStatus(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<TeamStatusData> {
  const res = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/team-status`, {
    headers: makeHeaders(token),
  });
  return handleResponse<TeamStatusData>(res);
}
