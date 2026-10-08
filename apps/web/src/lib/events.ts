import type { EventEnvelope } from "@agents-hub/shared";
import { decodeCursor } from "@agents-hub/shared";
import type { ConnectionStatus } from "../types/index.js";
import { ApiClientError, ackInbox, createWsTicket, fetchInbox } from "./api.js";

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
  private recovery: Promise<void> | null = null;
  private recoverAgain = false;
  private deliveredSequence = 0;
  private recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
  private errorListeners = new Set<(error: unknown | null) => void>();
  private historyUnavailable = false;

  public async acceptHistoryGap(cursor: string): Promise<void> {
    if (!this.historyUnavailable || this.isDestroyed) return;
    const ack = await ackInbox(
      this.config.baseUrl,
      this.config.token,
      this.config.projectId,
      this.config.sessionId,
      cursor,
      true,
    );
    if (this.isDestroyed) return;
    this.setLastCursor(ack.cursor);
    this.historyUnavailable = false;
    await this.recoverMissedEvents();
  }

  public onRecoveryError(listener: (error: unknown | null) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

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
      this.lastCursor = null;
      this.lastSequence = 0;
      this.deliveredSequence = 0;
      this.historyUnavailable = false;
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
    this.lastSequence = cursor ? (decodeCursor(cursor) ?? 0) : 0;
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
          // Live frames trigger an ordered inbox drain: advancing directly to a
          // live sequence could skip earlier events during reconnection.
          if (data?.type === "event" && data.data?.sequence) {
            void this.recoverMissedEvents();
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
    if (event.sequence <= this.deliveredSequence || this.isDestroyed) return;
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener error
      }
    }
    this.deliveredSequence = event.sequence;
  }

  public async recoverMissedEvents(): Promise<void> {
    if (this.isDestroyed || this.historyUnavailable) return;
    this.recoverAgain = true;
    if (this.recovery) return this.recovery;
    this.recovery = this.drainInbox();
    try {
      await this.recovery;
    } finally {
      this.recovery = null;
    }
  }

  private async drainInbox(): Promise<void> {
    try {
      while (this.recoverAgain && !this.isDestroyed) {
        this.recoverAgain = false;
        let hasMore = true;
        while (hasMore && !this.isDestroyed) {
          const inbox = await fetchInbox(
            this.config.baseUrl,
            this.config.token,
            this.config.projectId,
            this.config.sessionId,
            this.lastCursor ?? undefined,
          );
          if (this.isDestroyed) return;
          for (const ev of inbox.events) {
            this.handleIncomingEvent(ev);
          }
          if (inbox.events.length > 0) {
            const cursor = inbox.next_cursor;
            await ackInbox(
              this.config.baseUrl,
              this.config.token,
              this.config.projectId,
              this.config.sessionId,
              cursor,
            );
            if (this.isDestroyed) return;
            this.lastCursor = cursor;
            this.lastSequence = decodeCursor(cursor) ?? this.lastSequence;
          }
          hasMore = inbox.has_more;
        }
      }
      for (const listener of this.errorListeners) listener(null);
    } catch (error) {
      if (this.isDestroyed) return;
      if (error instanceof ApiClientError && error.code === "CURSOR_EXPIRED")
        this.historyUnavailable = true;
      for (const listener of this.errorListeners) listener(error);
      if (!this.historyUnavailable && !this.recoveryTimeout)
        this.recoveryTimeout = setTimeout(() => {
          this.recoveryTimeout = null;
          void this.recoverMissedEvents();
        }, 2000);
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
    if (this.recoveryTimeout) clearTimeout(this.recoveryTimeout);
    this.errorListeners.clear();
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
