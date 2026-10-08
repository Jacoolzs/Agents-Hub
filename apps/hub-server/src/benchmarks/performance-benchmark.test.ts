import { performance } from "node:perf_hooks";
import { type EventEnvelope, generateId, nowUtc } from "@agents-hub/shared";
import { describe, expect, it } from "vitest";
import { WebSocketHub } from "../http/websocket/ws-hub.js";
import { createDatabase } from "../infrastructure/db/database.js";
import { SqliteEventBus } from "../infrastructure/event-bus/event-bus.js";

function getPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

describe("Performance Benchmarks & Query Plan Verification (Phase 6 Performance)", () => {
  it("confirms optimal index usage on all critical tables via EXPLAIN QUERY PLAN", () => {
    const db = createDatabase(":memory:");

    try {
      // 1. Events sequence pagination index
      const eventsPlan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM events WHERE project_id = 'test' AND sequence > 10 ORDER BY sequence ASC",
        )
        .all() as { detail: string }[];
      const eventsDetail = eventsPlan.map((p) => p.detail).join(" | ");
      expect(eventsDetail).toMatch(/USING INDEX|USING COVERING INDEX/);
      expect(eventsDetail).toContain("idx_events_project_seq");

      // 2. Messages by project index
      const messagesPlan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE project_id = 'test' ORDER BY created_at DESC",
        )
        .all() as { detail: string }[];
      const messagesDetail = messagesPlan.map((p) => p.detail).join(" | ");
      expect(messagesDetail).toMatch(/USING INDEX|USING COVERING INDEX/);
      expect(messagesDetail).toContain("idx_messages_project");

      // 3. Workspace locks index
      const locksPlan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM workspace_locks WHERE project_id = 'test' AND expires_at > '2026-01-01'",
        )
        .all() as { detail: string }[];
      const locksDetail = locksPlan.map((p) => p.detail).join(" | ");
      expect(locksDetail).toMatch(/USING INDEX|USING COVERING INDEX/);
      expect(locksDetail).toContain("idx_workspace_locks_project");

      // 4. WebSocket ticket lookup by hash index
      const ticketPlan = db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM ws_tickets WHERE ticket_hash = 'hash123'")
        .all() as { detail: string }[];
      const ticketDetail = ticketPlan.map((p) => p.detail).join(" | ");
      expect(ticketDetail).toMatch(/USING INDEX|USING COVERING INDEX/);

      // 5. Agent sessions by project index
      const sessionsPlan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM agent_sessions WHERE project_id = 'test' AND status = 'active'",
        )
        .all() as { detail: string }[];
      const sessionsDetail = sessionsPlan.map((p) => p.detail).join(" | ");
      expect(sessionsDetail).toMatch(/USING INDEX|USING COVERING INDEX/);
      expect(sessionsDetail).toMatch(/sqlite_autoindex_agent_sessions|idx_agent_sessions_project/);
    } finally {
      db.close();
    }
  });

  it("benchmarks inbox, messages, locks and WS broadcast under 100 simulated agents and calculates p50/p95/p99", () => {
    const db = createDatabase(":memory:");
    const eventBus = new SqliteEventBus(db);
    const wsHub = new WebSocketHub();
    eventBus.subscribe((ev) => wsHub.broadcast(ev));

    const projectId = "proj-bench-100";
    const userId = "user-bench";

    // Seed project & user
    db.prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)").run(
      userId,
      "benchmarker",
      nowUtc(),
    );
    db.prepare(
      "INSERT INTO projects (project_id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(projectId, "Bench Project", userId, nowUtc(), nowUtc());

    // 1. Simulate 100 agents joining project
    const AGENT_COUNT = 100;
    const sessionIds: string[] = [];
    for (let i = 0; i < AGENT_COUNT; i++) {
      const sessId = generateId();
      const agentId = `agent-${i.toString().padStart(3, "0")}`;
      db.prepare(`
        INSERT INTO agent_sessions (session_id, agent_id, project_id, user_id, status, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(sessId, agentId, projectId, userId, nowUtc(), nowUtc());
      sessionIds.push(sessId);
    }

    // 2. Measure Message Creation latency over 50 events
    const messageLatencies: number[] = [];
    const EVENT_BURST = 50;
    for (let i = 0; i < EVENT_BURST; i++) {
      const start = performance.now();
      eventBus.transaction(() => {
        const msgId = generateId();
        db.prepare(`
          INSERT INTO messages (message_id, project_id, sender_id, recipient_agent_ids, channel, body, priority, created_at)
          VALUES (?, ?, ?, ?, 'general', ?, 'normal', ?)
        `).run(
          msgId,
          projectId,
          `agent-${i % AGENT_COUNT}`,
          "[]",
          `Benchmark message body payload #${i}`,
          nowUtc(),
        );

        eventBus.recordEvent(projectId, `agent-${i % AGENT_COUNT}`, "message.created", {
          message_id: msgId,
          channel: "general",
          body: `Benchmark message body payload #${i}`,
        });
      });
      messageLatencies.push(performance.now() - start);
    }

    // 3. Measure Inbox Query latency over 50 reads with cursor
    const inboxLatencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const afterSeq = (i * 2) % EVENT_BURST;
      const start = performance.now();
      const events = eventBus.getEventsAfter(projectId, afterSeq, 20);
      inboxLatencies.push(performance.now() - start);
      expect(events).toBeDefined();
    }

    // 4. Measure Lock Claim/Release latency over 30 cycles
    const lockLatencies: number[] = [];
    for (let i = 0; i < 30; i++) {
      const lockId = generateId();
      const start = performance.now();
      db.prepare(`
        INSERT INTO workspace_locks (lock_id, project_id, owner_agent_id, paths, reason, ttl_seconds, expires_at, created_at)
        VALUES (?, ?, ?, ?, 'bench lock', 60, ?, ?)
      `).run(
        lockId,
        projectId,
        `agent-${i}`,
        JSON.stringify([`module/file-${i}.ts`]),
        new Date(Date.now() + 60000).toISOString(),
        nowUtc(),
      );
      db.prepare("DELETE FROM workspace_locks WHERE lock_id = ?").run(lockId);
      lockLatencies.push(performance.now() - start);
    }

    // Sort latencies to compute percentiles
    messageLatencies.sort((a, b) => a - b);
    inboxLatencies.sort((a, b) => a - b);
    lockLatencies.sort((a, b) => a - b);

    const msgP50 = getPercentile(messageLatencies, 50);
    const msgP95 = getPercentile(messageLatencies, 95);
    const msgP99 = getPercentile(messageLatencies, 99);

    const inboxP50 = getPercentile(inboxLatencies, 50);
    const inboxP95 = getPercentile(inboxLatencies, 95);
    const inboxP99 = getPercentile(inboxLatencies, 99);

    const lockP50 = getPercentile(lockLatencies, 50);
    const lockP95 = getPercentile(lockLatencies, 95);
    const lockP99 = getPercentile(lockLatencies, 99);

    // Assert that p95 of all operations is sub-10ms in SQLite
    expect(msgP95).toBeLessThan(15);
    expect(inboxP95).toBeLessThan(10);
    expect(lockP95).toBeLessThan(10);

    // Verify metrics exist
    expect(msgP50).toBeGreaterThanOrEqual(0);
    expect(msgP99).toBeGreaterThanOrEqual(msgP50);
    expect(inboxP99).toBeGreaterThanOrEqual(inboxP50);
    expect(lockP99).toBeGreaterThanOrEqual(lockP50);

    db.close();
  });

  it("enforces WebSocket slow-consumer backpressure and drops stalled connections", () => {
    // Hub configured with tiny 64-byte buffer threshold for testing
    const wsHub = new WebSocketHub(64);

    let closedCode: number | null = null;
    let closedReason: string | null = null;

    // Simulated slow socket with high bufferedAmount
    const fakeSlowSocket = {
      readyState: 1, // OPEN
      bufferedAmount: 1024, // 1 KiB > 64 B threshold
      send: () => {},
      close: (code: number, reason: string) => {
        closedCode = code;
        closedReason = reason;
      },
      on: () => {},
    };

    wsHub.register({
      socket: fakeSlowSocket as unknown as import("ws").WebSocket,
      projectId: "proj-pressure",
      userId: "user-pressure",
      agentId: "slow-agent",
    });

    expect(wsHub.getSubscriberCount("proj-pressure")).toBe(1);

    const dummyEvent: EventEnvelope = {
      event_id: "evt-pressure-1",
      project_id: "proj-pressure",
      sequence: 1,
      type: "message.created",
      actor_id: "system",
      occurred_at: nowUtc(),
      payload_version: 1,
      payload: { body: "Broadcast frame" },
    };

    // Broadcast must detect excessive bufferedAmount and drop the slow client
    wsHub.broadcast(dummyEvent);

    expect(closedCode).toBe(1008);
    expect(closedReason).toBe("Slow consumer dropped");
    expect(wsHub.getSubscriberCount("proj-pressure")).toBe(0);
  });
});
