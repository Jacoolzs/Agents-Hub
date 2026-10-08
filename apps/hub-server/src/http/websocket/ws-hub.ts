import type { EventEnvelope } from "@agents-hub/shared";
import type { WebSocket } from "ws";
import { isEventVisibleToAgent } from "../../application/policies/event-visibility.js";

interface ClientSubscription {
  socket: WebSocket;
  projectId: string;
  agentId?: string | undefined;
  userId: string;
  authorized?: () => boolean;
}

export class WebSocketHub {
  private subscriptions: Set<ClientSubscription> = new Set();
  private maxBufferedAmount: number;

  constructor(
    maxBufferedAmount = 1024 * 1024,
    private maxConnections = 200,
  ) {
    this.maxBufferedAmount = maxBufferedAmount;
  }

  public register(sub: ClientSubscription): boolean {
    if (this.subscriptions.size >= this.maxConnections) {
      sub.socket.close(1013, "Connection limit reached");
      return false;
    }
    this.subscriptions.add(sub);

    sub.socket.on("close", () => {
      this.subscriptions.delete(sub);
    });

    sub.socket.on("error", () => {
      this.subscriptions.delete(sub);
    });
    return true;
  }

  public broadcast(event: EventEnvelope): void {
    const payloadStr = JSON.stringify({ type: "event", data: event });

    for (const sub of this.subscriptions) {
      if (sub.authorized && !sub.authorized()) {
        sub.socket.close(1008, "Access revoked");
        this.subscriptions.delete(sub);
        continue;
      }
      if (sub.projectId === event.project_id && sub.socket.readyState === 1) {
        if (!isEventVisibleToAgent(event, sub.agentId)) {
          continue;
        }

        // Backpressure / slow consumer protection:
        // If outbound buffer is excessive, drop slow consumer to protect server memory
        if (sub.socket.bufferedAmount > this.maxBufferedAmount) {
          try {
            sub.socket.close(1008, "Slow consumer dropped");
          } catch {
            // ignore close error
          }
          this.subscriptions.delete(sub);
          continue;
        }

        try {
          sub.socket.send(payloadStr);
        } catch {
          this.subscriptions.delete(sub);
        }
      }
    }
  }

  public getSubscriberCount(projectId?: string): number {
    if (!projectId) return this.subscriptions.size;
    let count = 0;
    for (const sub of this.subscriptions) {
      if (sub.projectId === projectId) count++;
    }
    return count;
  }

  public closeAll(code = 1001, reason = "Server shutting down"): void {
    for (const sub of this.subscriptions) {
      try {
        sub.socket.close(code, reason);
      } catch {
        // ignore close error
      }
    }
    this.subscriptions.clear();
  }

  public revalidate(): void {
    for (const sub of this.subscriptions) {
      if (sub.authorized && !sub.authorized()) {
        sub.socket.close(1008, "Access revoked");
        this.subscriptions.delete(sub);
      }
    }
  }
}
