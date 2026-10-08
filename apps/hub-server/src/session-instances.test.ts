import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeCursor } from "@agents-hub/shared";
import { describe, expect, it, vi } from "vitest";
import { HubClient } from "../../../packages/mcp-server/src/client/hub-client.js";
import { buildApp } from "./app.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";

describe("Exclusive agent instances", () => {
  for (const [route, table, payload, operation] of [
    ["messages", "messages", { body: "Accepted before restart" }, "message.create"],
    ["status", "status_reports", { objective: "Accepted before restart" }, "status.report"],
    [
      "locks/claim",
      "workspace_locks",
      { paths: ["src/retry"], reason: "Accepted before restart" },
      "lock.claim",
    ],
  ] as const) {
    it(`replays ${operation} across generations but rejects a different agent using the same key`, async () => {
      const app = buildApp();
      try {
        const project = app.ctx.projectService.createProject("Retry after restart", "owner").project
          .project_id;
        const headers = {
          authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
          "idempotency-key": "survive-restart",
        };
        const first = app.ctx.sessionService.joinProject(project, "agent", "owner");
        const send = (sessionId: string) =>
          app.inject({
            method: "POST",
            url: `/v1/projects/${project}/${route}`,
            headers,
            payload: { session_id: sessionId, ...payload },
          });
        const accepted = await send(first.session_id);
        expect(accepted.statusCode).toBe(201);
        app.ctx.sessionService.disconnect(project, "agent");
        const resumed = app.ctx.sessionService.joinProject(project, "agent", "owner");
        const retry = await send(resumed.session_id);
        expect(retry.statusCode).toBe(201);
        expect(retry.json().data).toEqual(accepted.json().data);
        expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
        expect(
          app.ctx.db
            .prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = ?")
            .get(operation)?.n,
        ).toBe(1);
        const other = app.ctx.sessionService.joinProject(project, "other-agent", "owner");
        const conflict = await send(other.session_id);
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
        expect((await send(first.session_id)).statusCode).toBe(401);
      } finally {
        await app.close();
        app.ctx.db.close();
      }
    });
  }

  for (const release of [false, true]) {
    it(`retries lock ${release ? "release" : "renewal"} across generations without extra mutation`, async () => {
      const app = buildApp();
      try {
        const project = app.ctx.projectService.createProject("Lock retry", "owner").project
          .project_id;
        const original = app.ctx.sessionService.joinProject(project, "agent", "owner");
        const lock = app.ctx.lockService.claimLock(project, "agent", {
          paths: ["src/a"],
          reason: "Work",
          ttl_seconds: 300,
        });
        const headers = {
          authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
          "idempotency-key": "lock-restart",
        };
        const send = (sessionId: string) =>
          app.inject({
            method: release ? "DELETE" : "POST",
            url: `/v1/projects/${project}/locks/${lock.lock_id}${release ? "" : "/renew"}`,
            headers,
            payload: { session_id: sessionId, ...(release ? {} : { ttl_seconds: 600 }) },
          });
        const accepted = await send(original.session_id);
        expect(accepted.statusCode).toBe(200);
        app.ctx.sessionService.disconnect(project, "agent");
        const resumed = app.ctx.sessionService.joinProject(project, "agent", "owner");
        const sequence = app.ctx.eventBus.getMaxSequence(project);
        const retry = await send(resumed.session_id);
        expect(retry.statusCode).toBe(200);
        expect(retry.json().data).toEqual(accepted.json().data);
        expect(app.ctx.eventBus.getMaxSequence(project)).toBe(sequence);
        expect(
          app.ctx.db
            .prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = ?")
            .get(release ? "lock.release" : "lock.renew")?.n,
        ).toBe(1);
        expect(app.ctx.lockService.getActiveLocks(project)).toHaveLength(release ? 0 : 1);
      } finally {
        await app.close();
        app.ctx.db.close();
      }
    });
  }
  it("closes an old socket when an expired lease is replaced", async () => {
    const app = buildApp();
    let socket: globalThis.WebSocket | undefined;
    try {
      const owner = crypto.randomUUID();
      const project = app.ctx.projectService.createProject("Sockets", owner).project.project_id;
      const first = app.ctx.sessionService.joinProject(
        project,
        "agent",
        owner,
        crypto.randomUUID(),
      );
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      await app.listen({ host: "127.0.0.1", port: 0 });
      socket = new globalThis.WebSocket(
        `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/projects/${project}/events?token=${token}&session_id=${first.session_id}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      const connected = socket;
      const welcome = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Socket welcome timeout")), 3000);
        connected.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(String(event.data));
        };
        connected.onerror = (event) => {
          clearTimeout(timeout);
          reject(event);
        };
      });
      expect(JSON.parse(welcome).type).toBe("connected");
      const closed = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Socket close timeout")), 3000);
        connected.onclose = (event) => {
          clearTimeout(timeout);
          resolve(event.code);
        };
      });
      app.ctx.db
        .prepare("UPDATE agent_sessions SET last_seen_at = ? WHERE session_id = ?")
        .run(new Date(Date.now() - 181000).toISOString(), first.session_id);
      const resumed = app.ctx.sessionService.joinProject(
        project,
        "agent",
        owner,
        crypto.randomUUID(),
      );
      expect(await closed).toBe(1008);
      expect(app.ctx.sessionService.getSessionById(resumed.session_id).status).toBe("active");
    } finally {
      socket?.close();
      await app.close();
      app.ctx.db.close();
    }
  });

  it("upgrades a v4 backup without losing checkpoints and preserves instance binding on reopen", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-instances-"));
    const file = path.join(directory, "legacy.sqlite");
    const backup = path.join(directory, "backup.sqlite");
    const owner = crypto.randomUUID();
    const project = crypto.randomUUID();
    const oldId = crypto.randomUUID();
    const instance = crypto.randomUUID();
    try {
      const legacy = new DatabaseSync(file);
      try {
        legacy.exec(
          "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        );
        for (const migration of MIGRATIONS.filter((migration) => migration.version <= 4)) {
          legacy.exec(migration.sql);
          legacy
            .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
        }
        const now = new Date().toISOString();
        legacy.prepare("INSERT INTO users VALUES (?, 'owner', ?)").run(owner, now);
        legacy
          .prepare("INSERT INTO projects VALUES (?, 'Legacy', ?, ?, ?)")
          .run(project, owner, now, now);
        legacy
          .prepare("INSERT INTO memberships VALUES (?, ?, ?, 'owner', ?)")
          .run(crypto.randomUUID(), project, owner, now);
        legacy
          .prepare(
            "INSERT INTO agent_sessions (session_id, agent_id, project_id, user_id, status, last_cursor, last_seen_at, created_at, last_sequence) VALUES (?, 'agent', ?, ?, 'disconnected', ?, ?, ?, 4)",
          )
          .run(oldId, project, owner, encodeCursor(4), now, now);
        legacy.prepare("INSERT INTO project_sequences VALUES (?, 4, 2)").run(project);
        backupDatabase(legacy, backup);
      } finally {
        legacy.close();
      }
      const app = buildApp({}, createDatabase(backup));
      let replacement: string;
      try {
        const session = app.ctx.sessionService.joinProject(project, "agent", owner, instance);
        replacement = session.session_id;
        expect(replacement).not.toBe(oldId);
        expect(session.last_cursor).toBe(encodeCursor(4));
        expect(app.ctx.eventBus.getRetentionBoundary(project)).toBe(2);
        expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(6);
        expect(
          app.ctx.db
            .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?")
            .get("idx_messages_history")?.present,
        ).toBe(1);
      } finally {
        await app.close();
        app.ctx.db.close();
      }
      const reopened = buildApp({}, createDatabase(backup));
      try {
        const same = reopened.ctx.sessionService.joinProject(project, "agent", owner, instance);
        expect(same.session_id).toBe(replacement);
        expect(same.last_cursor).toBe(encodeCursor(4));
        expect(reopened.ctx.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        await reopened.close();
        reopened.ctx.db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
  it("retries a lost join response with one instance, one session and one joined event", async () => {
    const app = buildApp();
    const owner = crypto.randomUUID();
    const instance = crypto.randomUUID();
    const project = app.ctx.projectService.createProject("Retry join", owner).project.project_id;
    const token = app.ctx.authService.createToken(owner, "agents-hub");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const realFetch = globalThis.fetch;
    let requests = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      const response = await realFetch(input, options);
      requests++;
      if (requests === 1) {
        await response.text();
        const error = new Error("Response lost after commit") as Error & { code: string };
        error.code = "ECONNRESET";
        throw error;
      }
      return response;
    });
    try {
      const client = new HubClient({
        baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
        token,
      });
      const session = await client.createSession(project, "agent", instance);
      expect(requests).toBe(2);
      expect(app.ctx.sessionService.getActiveSessions(project)).toHaveLength(1);
      expect(
        app.ctx.eventBus.getEventsAfter(project).filter((event) => event.type === "agent.joined"),
      ).toHaveLength(1);
      expect(session).not.toHaveProperty("instance_id");
      const same = await client.createSession(project, "agent", instance);
      expect(same.session_id).toBe(session.session_id);
      await expect(client.createSession(project, "agent", crypto.randomUUID())).rejects.toThrow(
        "instancia conectada",
      );
    } finally {
      spy.mockRestore();
      await app.close();
      app.ctx.db.close();
    }
  });

  it("enforces the configured lease before maintenance and fences a delayed process after resuming", async () => {
    const app = buildApp({ SESSION_EXPIRE_SECONDS: 90 });
    try {
      const project = app.ctx.projectService.createProject("Lease", "owner").project.project_id;
      const instance = crypto.randomUUID();
      const first = app.ctx.sessionService.joinProject(project, "agent", "owner", instance);
      app.ctx.db
        .prepare("UPDATE agent_sessions SET last_seen_at = ? WHERE session_id = ?")
        .run(new Date(Date.now() - 91000).toISOString(), first.session_id);
      expect(() =>
        app.ctx.sessionService.validateSessionForUser(first.session_id, "owner", project),
      ).toThrow("SESSION_EXPIRED");
      const second = app.ctx.sessionService.joinProject(
        project,
        "agent",
        "owner",
        crypto.randomUUID(),
      );
      expect(second.session_id).not.toBe(first.session_id);
      const headers = {
        authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
      };
      for (const method of ["POST", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url: `/v1/sessions/${first.session_id}${method === "POST" ? "/heartbeat" : ""}`,
          headers,
          payload: { project_id: project, agent_id: "agent" },
        });
        expect(response.statusCode).toBe(401);
      }
      expect(app.ctx.sessionService.getSessionById(second.session_id).status).toBe("active");
      const events = app.ctx.eventBus.getEventsAfter(project);
      expect(events.filter((event) => event.type === "agent.left")).toHaveLength(1);
      expect(events.filter((event) => event.type === "agent.joined")).toHaveLength(2);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("rolls back session rotation and ticket deletion when join auditing fails", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Atomic rejoin", "owner").project
        .project_id;
      const first = app.ctx.sessionService.joinProject(project, "agent", "owner");
      const ticket = app.ctx.wsTicketService.createTicket("owner", project, first.session_id);
      app.ctx.sessionService.disconnect(project, "agent");
      const max = app.ctx.eventBus.getMaxSequence(project);
      app.ctx.db.exec(
        "CREATE TEMP TRIGGER reject_join BEFORE INSERT ON audit_entries WHEN NEW.action = 'session.join' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
      );
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${project}/sessions`,
        headers: {
          authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
        },
        payload: { agent_id: "agent", instance_id: crypto.randomUUID() },
      });
      expect(response.statusCode).toBe(500);
      expect(app.ctx.sessionService.getSessionById(first.session_id).status).toBe("disconnected");
      expect(app.ctx.eventBus.getMaxSequence(project)).toBe(max);
      expect(
        app.ctx.wsTicketService.consumeTicket(ticket, project, first.session_id).sessionId,
      ).toBe(first.session_id);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
  it("rejects concurrent joins without invalidating the winning session", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Instances", "owner").project.project_id;
      const headers = {
        authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
      };
      const join = () =>
        app.inject({
          method: "POST",
          url: `/v1/projects/${project}/sessions`,
          headers,
          payload: { agent_id: "agent" },
        });
      const responses = await Promise.all([join(), join()]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      const winner = responses.find((response) => response.statusCode === 201)?.json().data;
      const rejected = responses.find((response) => response.statusCode === 409);
      expect(rejected?.json().error.code).toBe("STATE_CONFLICT");
      expect(app.ctx.sessionService.getActiveSessions(project)).toHaveLength(1);
      const heartbeat = await app.inject({
        method: "POST",
        url: `/v1/sessions/${winner.session_id}/heartbeat`,
        headers,
        payload: { project_id: project, agent_id: "agent" },
      });
      expect(heartbeat.statusCode).toBe(200);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("preserves checkpoint while fencing old session IDs after disconnect and rejoin", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Fencing", "owner").project.project_id;
      const first = app.ctx.sessionService.joinProject(project, "agent", "owner");
      const checkpoint = encodeCursor(app.ctx.eventBus.getMaxSequence(project));
      const ticket = app.ctx.wsTicketService.createTicket("owner", project, first.session_id);
      const lock = app.ctx.lockService.claimLock(project, "agent", {
        paths: ["src/held"],
        reason: "Retained work",
        ttl_seconds: 300,
      });
      app.ctx.sessionService.updateCursor(project, first.agent_id, checkpoint);
      app.ctx.sessionService.disconnect(project, first.agent_id);
      const second = app.ctx.sessionService.joinProject(project, "agent", "owner");
      expect(second.session_id).not.toBe(first.session_id);
      expect(second.last_cursor).toBe(checkpoint);
      expect(() => app.ctx.sessionService.getSessionById(first.session_id)).toThrow(
        "SESSION_EXPIRED",
      );
      expect(app.ctx.lockService.getActiveLocks(project)).toEqual([lock]);
      expect(() =>
        app.ctx.wsTicketService.consumeTicket(ticket, project, first.session_id),
      ).toThrow("UNAUTHENTICATED");
      const headers = {
        authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
      };
      for (const [url, payload] of [
        [`/v1/projects/${project}/messages`, { body: "Stale message" }],
        [`/v1/projects/${project}/inbox/ack`, { cursor: checkpoint }],
        [`/v1/projects/${project}/locks/claim`, { paths: ["src/stale"], reason: "Stale lock" }],
        [`/v1/projects/${project}/ws-ticket`, {}],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url,
          headers,
          payload: { session_id: first.session_id, ...payload },
        });
        expect(response.statusCode).toBe(401);
      }
      expect(app.ctx.sessionService.getSessionById(second.session_id).last_cursor).toBe(checkpoint);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
});
