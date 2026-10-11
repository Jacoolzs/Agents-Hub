import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { BackgroundListener } from "./background-listener.js";

const room = { projectId: crypto.randomUUID(), sessionId: crypto.randomUUID(), agentId: "fixture" };
it("aborts a pending ticket, cancels backoff and never reconnects on authority failure", async () => {
  const authority = {
    openEvents: vi.fn(async () => {
      throw Object.assign(new Error("secret"), { status: 403 });
    }),
  };
  const changed = vi.fn();
  const listener = new BackgroundListener(authority, room, changed);
  await sleep(20);
  await listener.stop();
  expect(authority.openEvents).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  const pending = {
    openEvents: vi.fn(
      async (_project: string, _session: string, signal: AbortSignal): Promise<WebSocket> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    ),
  };
  const second = new BackgroundListener(pending, room, changed);
  await second.stop();
  expect(pending.openEvents).toHaveBeenCalledTimes(1);
});
it("ignores invalid/unrelated frames and cancels coalesced hints on shutdown", async () => {
  const socket = new EventEmitter() as EventEmitter & { terminate(): void; close(): void };
  socket.terminate = () => {
    socket.emit("close", 1006);
  };
  socket.close = () => {
    socket.emit("close", 1008);
  };
  const changed = vi.fn();
  const provider = { openEvents: vi.fn(async () => socket as unknown as WebSocket) };
  const listener = new BackgroundListener(provider, room, changed);
  await sleep(0);
  socket.emit("message", Buffer.from("bad JSON"), false);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "event", data: {} })), false);
  await sleep(300);
  expect(changed).not.toHaveBeenCalled();
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({ type: "connected", projectId: room.projectId, agentId: room.agentId }),
    ),
    false,
  );
  await listener.stop();
  await sleep(300);
  expect(changed).not.toHaveBeenCalled();
  expect(provider.openEvents).toHaveBeenCalledTimes(1);
});
