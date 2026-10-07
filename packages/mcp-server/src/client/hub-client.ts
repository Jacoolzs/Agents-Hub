import { withRetry } from "./retry.js";

export interface HubClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class HubClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: HubClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  public async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const method = options.method ?? "GET";
    const timeout = options.timeoutMs ?? this.timeoutMs;

    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            "x-request-id": crypto.randomUUID(),
          },
          signal: controller.signal,
        };
        if (options.body !== undefined) {
          fetchOptions.body = JSON.stringify(options.body);
        }

        const res = await fetch(url, fetchOptions);

        const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };

        if (!res.ok) {
          const err = new Error(json.error?.message ?? `HTTP ${res.status}: ${res.statusText}`);
          (err as { status?: number }).status = res.status;
          (err as { code?: string }).code = json.error?.code ?? "API_ERROR";
          throw err;
        }

        return json.data as T;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  public async createSession(projectId: string, agentId: string) {
    return this.request<{ session_id: string; project_id: string; agent_id: string }>(
      `/v1/projects/${projectId}/sessions`,
      {
        method: "POST",
        body: { agent_id: agentId },
      },
    );
  }

  public async heartbeat(sessionId: string, projectId: string, agentId: string) {
    return this.request<{ status: string }>(`/v1/sessions/${sessionId}/heartbeat`, {
      method: "POST",
      body: { project_id: projectId, agent_id: agentId },
    });
  }

  public async getInbox(projectId: string, cursor?: string, limit = 50) {
    let qs = `?limit=${limit}`;
    if (cursor) qs += `&after=${encodeURIComponent(cursor)}`;
    return this.request<{
      events: Array<{ sequence: number; type: string; payload: unknown }>;
      next_cursor: string;
      has_more: boolean;
    }>(`/v1/projects/${projectId}/inbox${qs}`);
  }

  public async sendMessage(
    projectId: string,
    senderId: string,
    body: {
      body: string;
      channel?: string | undefined;
      recipient_agent_ids?: string[] | undefined;
      priority?: string | undefined;
      correlation_id?: string | undefined;
    },
  ) {
    return this.request(`/v1/projects/${projectId}/messages`, {
      method: "POST",
      body: {
        sender_id: senderId,
        ...body,
      },
    });
  }

  public async reportStatus(
    projectId: string,
    agentId: string,
    body: {
      objective: string;
      progress?: string | undefined;
      decision?: string | undefined;
      blocked_by?: string | undefined;
      next_step?: string | undefined;
    },
  ) {
    return this.request(`/v1/projects/${projectId}/status`, {
      method: "POST",
      body: {
        agent_id: agentId,
        ...body,
      },
    });
  }

  public async claimLock(
    projectId: string,
    agentId: string,
    body: {
      paths: string[];
      reason: string;
      ttl_seconds?: number | undefined;
    },
  ) {
    return this.request(`/v1/projects/${projectId}/locks/claim`, {
      method: "POST",
      body: {
        agent_id: agentId,
        ...body,
      },
    });
  }

  public async releaseLock(projectId: string, agentId: string, paths: string[]) {
    return this.request(`/v1/projects/${projectId}/locks`, {
      method: "DELETE",
      body: {
        agent_id: agentId,
        paths,
      },
    });
  }

  public async getTeamStatus(projectId: string) {
    return this.request<{
      active_agents: unknown[];
      locks: unknown[];
      statuses: unknown[];
    }>(`/v1/projects/${projectId}/team-status`);
  }
}
