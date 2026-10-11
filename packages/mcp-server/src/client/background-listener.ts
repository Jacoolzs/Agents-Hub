import { setTimeout as sleep } from "node:timers/promises";
import { EventEnvelopeSchema } from "@agents-hub/shared";
import type WebSocket from "ws";
import type { HubClient } from "./hub-client.js";

/** Transport hints only. Durable inbox/authorization/ACK remain with existing HTTP tools. */
export class BackgroundListener {
  private controller = new AbortController();
  private socket: WebSocket | undefined;
  private notification: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<void>;
  constructor(
    private hub: Pick<HubClient, "openEvents">,
    private room: { projectId: string; sessionId: string; agentId: string },
    private changed: () => void,
  ) {
    this.task = this.run();
  }
  private hint() {
    if (this.controller.signal.aborted || this.notification) return;
    this.notification = setTimeout(() => {
      this.notification = undefined;
      if (!this.controller.signal.aborted) this.changed();
    }, 250);
    this.notification.unref();
  }
  private async run() {
    const signal = this.controller.signal;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const socket = await this.hub.openEvents(this.room.projectId, this.room.sessionId, signal);
        this.socket = socket;
        const code = await new Promise<number>((resolve) => {
          let authorized = false;
          let alive = true;
          const authorization = setTimeout(() => socket.close(1008), 10000);
          authorization.unref();
          const keepalive = setInterval(() => {
            if (!authorized) return;
            if (!alive) {
              socket.terminate();
              return;
            }
            alive = false;
            socket.ping();
          }, 30000);
          keepalive.unref();
          socket.on("pong", () => {
            alive = true;
          });
          const abort = () => socket.terminate();
          signal.addEventListener("abort", abort, { once: true });
          socket.on("error", () => {}); // Never print URL/ticket/remote diagnostics.
          socket.on("message", (bytes, binary) => {
            if (signal.aborted || binary) return;
            try {
              const message = JSON.parse(bytes.toString());
              if (message.type === "connected") {
                if (
                  message.projectId !== this.room.projectId ||
                  message.agentId !== this.room.agentId
                ) {
                  socket.close(1008);
                  return;
                }
                authorized = true;
                clearTimeout(authorization);
                failures = 0;
                this.hint(); // Reconnect catches up through authoritative HTTP, not WS replay.
                return;
              }
              const event = EventEnvelopeSchema.safeParse(
                message.type === "event" ? message.data : null,
              );
              if (
                authorized &&
                event.success &&
                event.data.project_id === this.room.projectId &&
                event.data.type !== "agent.heartbeat"
              )
                this.hint();
            } catch {
              /* Invalid data cannot advance any checkpoint. */
            }
          });
          socket.once("close", (code) => {
            signal.removeEventListener("abort", abort);
            clearTimeout(authorization);
            clearInterval(keepalive);
            clearTimeout(this.notification);
            this.notification = undefined;
            resolve(code);
          });
          if (signal.aborted) abort();
        });
        this.socket = undefined;
        if (code === 1008) return;
      } catch (error) {
        if ([401, 403].includes((error as { status?: number }).status ?? 0)) return;
      }
      if (signal.aborted) return;
      try {
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, {
          signal,
          ref: false,
        });
      } catch {
        return;
      }
    }
  }
  async stop() {
    this.controller.abort();
    clearTimeout(this.notification);
    this.socket?.terminate();
    await this.task;
  }
}
