import type { EventEnvelope } from "@agents-hub/shared";
import type { WebSocket } from "ws";

interface ClientSubscription {
  socket: WebSocket;
  projectId: string;
  agentId?: string;
  userId: string;
}

export class WebSocketHub {
  private subscriptions: Set<ClientSubscription> = new Set();

  public register(sub: ClientSubscription): void {
    this.subscriptions.add(sub);

    sub.socket.on("close", () => {
      this.subscriptions.delete(sub);
    });

    sub.socket.on("error", () => {
      this.subscriptions.delete(sub);
    });
  }

  public broadcast(event: EventEnvelope): void {
    const payloadStr = JSON.stringify({ type: "event", data: event });

    for (const sub of this.subscriptions) {
      if (sub.projectId === event.project_id && sub.socket.readyState === 1) {
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
}
