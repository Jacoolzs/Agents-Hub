import type { EventEnvelope } from "@agents-hub/shared";
import { encodeCursor } from "@agents-hub/shared";
import type { ConnectionStatus } from "../types/index.js";
import { ackInbox, createWsTicket, fetchInbox } from "./api.js";

export type EventListener = (event: EventEnvelope) => void;
export type StatusListener = (status: ConnectionStatus) => void;

export interface RealtimeManagerConfig {
  baseUrl: string;
  token: string;
  projectId: string;
  sessionId: string;
}

export class RealtimeManager {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private eventListeners: Set<EventListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private isDestroyed = false;
  private lastCursor: string | null = null;
  private lastSequence = 0;

  constructor(private config: RealtimeManagerConfig) {
    if (typeof window !== "undefined") {
      (
        window as unknown as { __agentsHubTestRealtime?: RealtimeManager | undefined }
      ).__agentsHubTestRealtime = this;
    }
  }

  public setConfig(config: RealtimeManagerConfig): void {
    const changed =
      this.config.baseUrl !== config.baseUrl ||
      this.config.token !== config.token ||
      this.config.projectId !== config.projectId ||
      this.config.sessionId !== config.sessionId;

    this.config = config;
    if (changed) {
      this.reconnectAttempts = 0;
      void this.connect();
    }
  }

  public subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getLastCursor(): string | null {
    return this.lastCursor;
  }

  public setLastCursor(cursor: string | null): void {
    this.lastCursor = cursor;
  }

  public forceCloseSocketForTest(): void {
    if (this.socket) {
      this.socket.close();
    }
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const listener of this.statusListeners) {
        try {
          listener(newStatus);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  public async connect(): Promise<void> {
    if (this.isDestroyed) return;
    this.cleanupSocket();

    this.setStatus(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");

    // Obtain an ephemeral one-time WebSocket ticket via authenticated HTTPS
    let ticket = "";
    try {
      const ticketRes = await createWsTicket(
        this.config.baseUrl,
        this.config.token,
        this.config.projectId,
        this.config.sessionId,
      );
      ticket = ticketRes.ticket;
    } catch {
      if (this.isDestroyed) return;
      this.setStatus("disconnected");
      this.startPollingFallback();
      this.scheduleReconnect();
      return;
    }

    if (this.isDestroyed) return;

    // Convert http/https baseUrl to ws/wss using ONLY ephemeral ticket
    let wsUrl: string;
    try {
      const url = new URL(this.config.baseUrl);
      const protocol = url.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = `${protocol}//${url.host}/v1/projects/${encodeURIComponent(
        this.config.projectId,
      )}/events?session_id=${encodeURIComponent(
        this.config.sessionId,
      )}&ticket=${encodeURIComponent(ticket)}`;
    } catch {
      // Relative fallback
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = `${protocol}//${window.location.host}/v1/projects/${encodeURIComponent(
        this.config.projectId,
      )}/events?session_id=${encodeURIComponent(
        this.config.sessionId,
      )}&ticket=${encodeURIComponent(ticket)}`;
    }

    try {
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
        if (this.isDestroyed) return;
        this.setStatus("connected");
        this.reconnectAttempts = 0;
        this.stopPollingFallback();

        // Perform recovery fetch using cursor upon reconnect
        void this.recoverMissedEvents();
      };

      this.socket.onmessage = (event) => {
        if (this.isDestroyed) return;
        try {
          const data = JSON.parse(event.data);
          // Fastify WS sends { type: "connected", projectId, agentId } or raw EventEnvelope
          if (data && typeof data === "object" && "sequence" in data && "type" in data) {
            const envelope = data as EventEnvelope;
            this.handleIncomingEvent(envelope);
          }
        } catch {
          // non-JSON message ignored
        }
      };

      this.socket.onerror = () => {
        if (this.isDestroyed) return;
        this.setStatus("error");
      };

      this.socket.onclose = () => {
        if (this.isDestroyed) return;
        this.cleanupSocket();
        this.setStatus("disconnected");
        this.startPollingFallback();
        this.scheduleReconnect();
      };
    } catch {
      this.setStatus("error");
      this.startPollingFallback();
      this.scheduleReconnect();
    }
  }

  private handleIncomingEvent(event: EventEnvelope): void {
    if (event.sequence > this.lastSequence) {
      this.lastSequence = event.sequence;
      this.lastCursor = encodeCursor(event.sequence);

      // Acknowledge cursor in background
      void ackInbox(
        this.config.baseUrl,
        this.config.token,
        this.config.projectId,
        this.config.sessionId,
        this.lastCursor,
      ).catch(() => {
        // non-blocking
      });
    }

    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener error
      }
    }
  }

  public async recoverMissedEvents(): Promise<void> {
    try {
      const inbox = await fetchInbox(
        this.config.baseUrl,
        this.config.token,
        this.config.projectId,
        this.config.sessionId,
        this.lastCursor ?? undefined,
      );

      if (inbox.events.length > 0) {
        for (const ev of inbox.events) {
          this.handleIncomingEvent(ev);
        }
      }
    } catch {
      // recovery failure will retry on next poll or reconnect
    }
  }

  private startPollingFallback(): void {
    if (this.pollingInterval || this.isDestroyed) return;
    // Poll inbox every 3 seconds ONLY when WS is down
    this.pollingInterval = setInterval(() => {
      void this.recoverMissedEvents();
    }, 3000);
  }

  private stopPollingFallback(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.isDestroyed) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 1.5 ** (this.reconnectAttempts - 1), 10000);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.isDestroyed) {
        void this.connect();
      }
    }, delay);
  }

  private cleanupSocket(): void {
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        // ignore close error
      }
      this.socket = null;
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (
      typeof window !== "undefined" &&
      (window as unknown as { __agentsHubTestRealtime?: RealtimeManager | undefined })
        .__agentsHubTestRealtime === this
    ) {
      (
        window as unknown as { __agentsHubTestRealtime?: RealtimeManager | undefined }
      ).__agentsHubTestRealtime = undefined;
    }
    this.stopPollingFallback();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupSocket();
    this.eventListeners.clear();
    this.statusListeners.clear();
    this.setStatus("disconnected");
  }
}
