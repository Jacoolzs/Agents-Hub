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
      signal?: AbortSignal | undefined;
      idempotencyKey?: string | undefined;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const method = options.method ?? "GET";
    const timeout = options.timeoutMs ?? this.timeoutMs;

    const execute = async () => {
      options.signal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            "x-request-id": crypto.randomUUID(),
            ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
          },
          signal: options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
        };
        if (options.body !== undefined) {
          fetchOptions.body = JSON.stringify(options.body);
        }

        const res = await fetch(url, fetchOptions);

        const json = (await res.json()) as {
          data?: T;
          error?: { code: string; message: string; details?: Record<string, unknown> };
        };

        if (!res.ok) {
          const err = new Error(json.error?.message ?? `HTTP ${res.status}: ${res.statusText}`);
          (err as { status?: number }).status = res.status;
          (err as { code?: string }).code = json.error?.code ?? "API_ERROR";
          (err as { details?: Record<string, unknown> | undefined }).details = json.error?.details;
          throw err;
        }

        return json.data as T;
      } finally {
        clearTimeout(timer);
      }
    };
    return method === "GET" || options.idempotencyKey
      ? withRetry(execute, { signal: options.signal })
      : execute();
  }

  public async createSession(projectId: string, agentId: string, instanceId = crypto.randomUUID()) {
    return this.request<{
      session_id: string;
      project_id: string;
      agent_id: string;
      last_cursor?: string;
    }>(`/v1/projects/${projectId}/sessions`, {
      method: "POST",
      idempotencyKey: instanceId,
      body: { agent_id: agentId, instance_id: instanceId },
    });
  }

  public async heartbeat(sessionId: string, projectId: string, agentId: string) {
    return this.request<{ status: string }>(`/v1/sessions/${sessionId}/heartbeat`, {
      method: "POST",
      body: { project_id: projectId, agent_id: agentId },
    });
  }

  public async disconnect(sessionId: string, projectId: string, agentId: string) {
    return this.request(`/v1/sessions/${sessionId}`, {
      method: "DELETE",
      body: { project_id: projectId, agent_id: agentId },
      timeoutMs: 1500,
    });
  }

  public async getInbox(
    projectId: string,
    sessionId?: string,
    cursor?: string,
    limit = 50,
    signal?: AbortSignal,
  ) {
    let qs = `?limit=${limit}`;
    if (cursor) qs += `&after=${encodeURIComponent(cursor)}`;
    if (sessionId) qs += `&session_id=${encodeURIComponent(sessionId)}`;
    return this.request<{
      events: Array<{ sequence: number; type: string; payload: unknown }>;
      next_cursor: string;
      has_more: boolean;
    }>(`/v1/projects/${projectId}/inbox${qs}`, { signal });
  }

  public async getInboxRecovery(projectId: string, sessionId: string) {
    return this.request<unknown>(
      `/v1/projects/${projectId}/inbox/recovery?session_id=${encodeURIComponent(sessionId)}`,
    );
  }

  public async ackInbox(
    projectId: string,
    sessionId: string,
    cursor: string,
    acceptHistoryGap = false,
  ) {
    return this.request<{ status: string; cursor: string }>(`/v1/projects/${projectId}/inbox/ack`, {
      method: "POST",
      body: {
        session_id: sessionId,
        cursor,
        ...(acceptHistoryGap ? { accept_history_gap: true } : {}),
      },
    });
  }

  public async sendMessage(
    projectId: string,
    sessionId: string,
    body: {
      body: string;
      channel?: string | undefined;
      recipient_agent_ids?: string[] | undefined;
      priority?: string | undefined;
      correlation_id?: string | undefined;
    },
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return this.request(`/v1/projects/${projectId}/messages`, {
      method: "POST",
      idempotencyKey,
      body: {
        session_id: sessionId,
        ...body,
      },
    });
  }

  public async reportStatus(
    projectId: string,
    sessionId: string,
    body: {
      objective: string;
      progress?: string | undefined;
      decision?: string | undefined;
      blocked_by?: string | undefined;
      next_step?: string | undefined;
    },
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return this.request(`/v1/projects/${projectId}/status`, {
      method: "POST",
      idempotencyKey,
      body: {
        session_id: sessionId,
        ...body,
      },
    });
  }

  public async claimLock(
    projectId: string,
    sessionId: string,
    body: {
      paths: string[];
      reason: string;
      ttl_seconds?: number | undefined;
    },
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return this.request(`/v1/projects/${projectId}/locks/claim`, {
      method: "POST",
      idempotencyKey,
      body: {
        session_id: sessionId,
        ...body,
      },
    });
  }

  public async renewLock(
    projectId: string,
    sessionId: string,
    lockId: string,
    ttlSeconds?: number,
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return this.request(`/v1/projects/${projectId}/locks/${lockId}/renew`, {
      method: "POST",
      idempotencyKey,
      body: {
        session_id: sessionId,
        ttl_seconds: ttlSeconds,
      },
    });
  }

  public async releaseLockById(projectId: string, sessionId: string, lockId: string) {
    return this.request(`/v1/projects/${projectId}/locks/${lockId}`, {
      method: "DELETE",
      idempotencyKey: crypto.randomUUID(),
      body: {
        session_id: sessionId,
      },
    });
  }

  public async releaseLock(projectId: string, sessionId: string, paths: string[]) {
    return this.request(`/v1/projects/${projectId}/locks`, {
      method: "DELETE",
      idempotencyKey: crypto.randomUUID(),
      body: {
        session_id: sessionId,
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
