import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeCursor } from "@agents-hub/shared";
import type { WebSocket as Socket } from "ws";
import { buildApp } from "../app.js";

const require = createRequire(import.meta.url);
const wsRequire = createRequire(require.resolve("@fastify/websocket"));
const WebSocket = wsRequire("ws") as typeof import("ws").WebSocket;
const duration = Number(process.env.BENCHMARK_SECONDS ?? 30);
if (!Number.isInteger(duration) || duration < 10 || duration > 300)
  throw new Error("BENCHMARK_SECONDS must be 10–300");
const run = crypto.randomUUID();
mkdirSync("data", { recursive: true });
const database = path.resolve(`data/benchmark-${run}.sqlite`);
const hub = buildApp({
  DATABASE_URL: database,
  NODE_ENV: "production",
  CORS_ORIGINS: "http://benchmark.local",
});
const sockets: Socket[] = [];
const errors: string[] = [];
const timings = {
  message: [] as number[],
  inbox: [] as number[],
  lock: [] as number[],
  websocket: [] as number[],
};
const deliveries = Array.from({ length: 100 }, () => new Set<number>());
let duplicateDeliveries = 0;
let polling = true;

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) =>
    Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(2));
  return {
    samples: samples.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
  };
}

async function benchmark() {
  await hub.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
  const owner = crypto.randomUUID();
  const project = hub.ctx.projectService.createProject("Network benchmark", owner).project
    .project_id;
  const root = `/v1/projects/${project}`;
  async function request<T>(
    token: string,
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${method} ${route.split("?")[0]}: ${response.status}`);
    return ((await response.json()) as { data: T }).data;
  }
  const clients = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const user = i === 0 ? owner : crypto.randomUUID();
      if (i > 0) {
        hub.ctx.db
          .prepare("INSERT INTO users VALUES (?, ?, ?)")
          .run(user, `benchmark-${i}`, new Date().toISOString());
        hub.ctx.db
          .prepare("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)")
          .run(crypto.randomUUID(), project, user, "collaborator", new Date().toISOString());
      }
      const token = hub.ctx.authService.createToken(user, "agents-hub");
      const session = await request<{ session_id: string }>(token, `${root}/sessions`, "POST", {
        agent_id: `agent-${i}`,
      });
      const ticket = await request<{ ticket: string }>(token, `${root}/ws-ticket`, "POST", {
        session_id: session.session_id,
      });
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `${base.replace("http:", "ws:")}${root}/events?session_id=${session.session_id}&ticket=${ticket.ticket}`,
          { origin: "http://benchmark.local", handshakeTimeout: 10000 },
        );
        sockets.push(socket);
        socket.once("error", reject);
        socket.on("message", (raw) => {
          const frame = JSON.parse(raw.toString());
          if (frame.type === "connected") resolve();
          if (frame.type === "event" && frame.data.type === "message.created") {
            const marker = JSON.parse(frame.data.payload.body) as { index: number; sent: number };
            if (deliveries[i]?.has(marker.index)) duplicateDeliveries++;
            deliveries[i]?.add(marker.index);
            timings.websocket.push(Date.now() - marker.sent);
          }
        });
        socket.on("close", () => {
          if (polling) errors.push(`Unexpected WS close: agent-${i}`);
        });
      });
      return { token, sessionId: session.session_id, cursor: "" };
    }),
  );
  const startSequence = hub.ctx.eventBus.getMaxSequence(project);
  const startCursor = encodeCursor(startSequence);
  for (const client of clients) client.cursor = startCursor;
  console.log("100 HTTP/WS clients connected; SQLite WAL on disk. Running 20 messages/s...");
  const consumers = clients.map(async (client) => {
    while (polling) {
      const before = performance.now();
      try {
        const inbox = await request<{ events: unknown[]; next_cursor: string }>(
          client.token,
          `${root}/inbox?session_id=${client.sessionId}&after=${client.cursor}&limit=100`,
        );
        timings.inbox.push(performance.now() - before);
        if (inbox.events.length) {
          await request(client.token, `${root}/inbox/ack`, "POST", {
            session_id: client.sessionId,
            cursor: inbox.next_cursor,
          });
          client.cursor = inbox.next_cursor;
        }
      } catch (error) {
        errors.push((error as Error).message);
      }
      await sleep(1000);
    }
  });
  const writer = clients[0];
  if (!writer) throw new Error("No writer");
  const messages = duration * 20;
  const started = performance.now();
  const pending = new Set<Promise<void>>();
  for (let i = 0; i < messages; i++) {
    await sleep(Math.max(0, started + i * 50 - performance.now()));
    if (pending.size >= 5) await Promise.race(pending);
    const before = performance.now();
    const write = request(writer.token, `${root}/messages`, "POST", {
      session_id: writer.sessionId,
      body: JSON.stringify({ index: i, sent: Date.now() }),
      channel: "benchmark",
    })
      .then(() => {
        timings.message.push(performance.now() - before);
      })
      .catch((error) => {
        errors.push((error as Error).message);
      });
    pending.add(write);
    void write.then(() => pending.delete(write));
    if (i % 20 === 0) {
      const lockStart = performance.now();
      const lock = await request<{ lock_id: string }>(writer.token, `${root}/locks/claim`, "POST", {
        session_id: writer.sessionId,
        paths: [`bench/module-${i}`],
        reason: "benchmark",
      });
      timings.lock.push(performance.now() - lockStart);
      await request(writer.token, `${root}/locks/${lock.lock_id}`, "DELETE", {
        session_id: writer.sessionId,
      });
    }
  }
  await Promise.all(pending);
  await sleep(Math.max(0, started + duration * 1000 - performance.now()));
  const elapsed = (performance.now() - started) / 1000;
  const events = hub.ctx.eventBus.getMaxSequence(project) - startSequence;
  await sleep(1000);
  polling = false;
  await Promise.all(consumers);
  const lost = deliveries.reduce((total, seen) => total + messages - seen.size, 0);
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
    ram_gib: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    database: "SQLite on disk, WAL",
    clients: 100,
    inbox_interval_ms: 1000,
    writer_concurrency_max: 5,
    seconds: Number(elapsed.toFixed(2)),
    messages,
    messages_per_second: Number((messages / elapsed).toFixed(2)),
    events_total: events,
    events_per_second: Number((events / elapsed).toFixed(2)),
    expected_ws_deliveries: messages * 100,
    received_ws_deliveries: timings.websocket.length,
    lost_ws_deliveries: lost,
    duplicate_ws_deliveries: duplicateDeliveries,
    errors,
    latency: {
      message: stats(timings.message),
      inbox: stats(timings.inbox),
      lock_claim: stats(timings.lock),
      websocket: stats(timings.websocket),
    },
  };
  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync("docs/evidence/network-benchmark.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || lost || duplicateDeliveries || elapsed > duration * 1.1)
    throw new Error("Network acceptance failed; inspect report");
}
try {
  await benchmark();
} finally {
  polling = false;
  for (const socket of sockets) socket.terminate();
  await hub.close();
  hub.ctx.db.close();
}
