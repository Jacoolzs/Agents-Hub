import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InboxRecoverySchema, encodeCursor } from "@agents-hub/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";

describe("Recovery after retention", () => {
  it("requires explicit acceptance, exposes only authorized snapshot fields, and replays retained visible events", async () => {
    const app = buildApp();
    try {
      const owner = crypto.randomUUID();
      const project = app.ctx.projectService.createProject("Gap", owner).project.project_id;
      const receiver = app.ctx.sessionService.joinProject(project, "receiver", owner);
      app.ctx.sessionService.joinProject(project, "sender", owner);
      app.ctx.sessionService.joinProject(project, "third", owner);
      app.ctx.statusService.reportStatus(project, "sender", {
        objective: "Current status",
        progress: "in_progress",
      });
      app.ctx.lockService.claimLock(project, "sender", {
        paths: ["src/api"],
        reason: "Current lock",
        ttl_seconds: 300,
      });
      const floor = app.ctx.eventBus.getMaxSequence(project);
      app.ctx.eventBus.pruneEventsBefore("9999-01-01T00:00:00.000Z");
      // All newer private events are hidden from receiver, until a visible message follows.
      for (let i = 0; i < 210; i++)
        app.ctx.messageService.sendMessage(project, "sender", {
          body: "Private secret",
          channel: "general",
          priority: "normal",
          recipient_agent_ids: ["third"],
        });
      const headers = {
        authorization: `Bearer ${app.ctx.authService.createToken(owner, "agents-hub", ["messages:read"])}`,
      };
      const base = `/v1/projects/${project}/inbox`;
      const snapshot = await app.inject({
        url: `${base}/recovery?session_id=${receiver.session_id}`,
        headers,
      });
      expect(snapshot.statusCode).toBe(200);
      const recovery = InboxRecoverySchema.parse(snapshot.json().data);
      expect(recovery.resume_cursor).toBe(encodeCursor(floor));
      expect(recovery.snapshot.statuses[0]?.objective).toBe("Current status");
      expect(recovery.snapshot).not.toHaveProperty("locks");
      expect(recovery.snapshot).not.toHaveProperty("active_agents");
      const full = await app.inject({
        url: `${base}/recovery?session_id=${receiver.session_id}`,
        headers: {
          authorization: `Bearer ${app.ctx.authService.createToken(owner, "agents-hub")}`,
        },
      });
      expect(InboxRecoverySchema.parse(full.json().data).snapshot.locks?.[0]?.paths).toEqual([
        "src/api",
      ]);
      expect(app.ctx.sessionService.getSessionById(receiver.session_id).last_cursor).toBe(
        encodeCursor(0),
      );
      const ack = (cursor: string, accept?: unknown) =>
        app.inject({
          method: "POST",
          url: `${base}/ack`,
          headers,
          payload: {
            session_id: receiver.session_id,
            cursor,
            ...(accept === undefined ? {} : { accept_history_gap: accept }),
          },
        });
      expect((await ack(encodeCursor(floor))).statusCode).toBe(410);
      expect((await ack(encodeCursor(floor + 1), true)).statusCode).toBe(400);
      expect((await ack(encodeCursor(floor), "true")).statusCode).toBe(422);
      const accepted = await ack(recovery.resume_cursor, true);
      expect(accepted.statusCode).toBe(200);
      const hidden = await app.inject({
        url: `${base}?session_id=${receiver.session_id}&after=${recovery.resume_cursor}`,
        headers,
      });
      expect(hidden.json().data).toEqual({
        events: [],
        next_cursor: recovery.resume_cursor,
        has_more: false,
      });
      app.ctx.messageService.sendMessage(project, "sender", {
        body: "Retained visible",
        channel: "general",
        priority: "normal",
      });
      const page = await app.inject({
        url: `${base}?session_id=${receiver.session_id}&after=${recovery.resume_cursor}&limit=1`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json().data.events).toHaveLength(1);
      expect(JSON.stringify(page.json())).toContain("Retained visible");
      expect(JSON.stringify(page.json())).not.toContain("Private secret");
      const tail = page.json().data.next_cursor;
      expect(app.ctx.sessionService.getSessionById(receiver.session_id).last_cursor).toBe(
        recovery.resume_cursor,
      );
      expect((await ack(tail)).statusCode).toBe(200);
      app.ctx.eventBus.pruneEventsBefore("9999-01-01T00:00:00.000Z");
      expect((await ack(tail)).statusCode).toBe(200); // Lost successful ACK response can be retried.
      expect((await ack(recovery.resume_cursor, true)).statusCode).toBe(400); // Snapshot became stale.
      const other = app.ctx.projectService.createProject("Other", crypto.randomUUID()).project
        .project_id;
      expect(
        (
          await app.inject({
            url: `/v1/projects/${other}/inbox/recovery?session_id=${receiver.session_id}`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        app.ctx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'inbox.accept_history_gap'",
          )
          .get()?.n,
      ).toBe(1);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("prunes a contiguous prefix despite clock changes and rolls retention back with its transaction", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Clock", "owner").project.project_id;
      const first = app.ctx.eventBus.recordEvent(project, "agent", "agent.heartbeat", {});
      const second = app.ctx.eventBus.recordEvent(project, "agent", "agent.heartbeat", {});
      app.ctx.db
        .prepare("UPDATE events SET occurred_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?")
        .run(second.event_id);
      expect(() =>
        app.ctx.eventBus.transaction(() => {
          app.ctx.eventBus.pruneEventsBefore("2001-01-01T00:00:00.000Z");
          throw new Error("Rollback retention");
        }),
      ).toThrow("Rollback retention");
      expect(app.ctx.eventBus.getRetentionBoundary(project)).toBe(0);
      expect(app.ctx.eventBus.getEventBySequence(project, first.sequence)).toBeDefined();
      app.ctx.eventBus.pruneEventsBefore("2001-01-01T00:00:00.000Z");
      expect(app.ctx.eventBus.getRetentionBoundary(project)).toBe(second.sequence);
      expect(app.ctx.eventBus.getEventsAfter(project)).toHaveLength(0);
      expect(app.ctx.eventBus.recordEvent(project, "agent", "agent.heartbeat", {}).sequence).toBe(
        second.sequence + 1,
      );
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("upgrades v3 histories including interior gaps and preserves boundaries through backup/reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-retention-"));
    try {
      const file = path.join(directory, "legacy.sqlite");
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      for (const migration of MIGRATIONS.filter((migration) => migration.version <= 3)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      }
      db.prepare("INSERT INTO users VALUES ('owner', 'owner', ?)").run(new Date().toISOString());
      for (const [project, sequences] of [
        ["prefix", [4, 5]],
        ["empty", []],
        ["interior", [1, 3, 5]],
        ["suffix", [1, 2]],
      ] as const) {
        db.prepare("INSERT INTO projects VALUES (?, ?, 'owner', ?, ?)").run(
          project,
          project,
          new Date().toISOString(),
          new Date().toISOString(),
        );
        db.prepare("INSERT INTO project_sequences VALUES (?, 5)").run(project);
        for (const sequence of sequences)
          db.prepare(
            "INSERT INTO events VALUES (?, ?, ?, 'agent.heartbeat', 'agent', ?, 1, '{}')",
          ).run(crypto.randomUUID(), project, sequence, new Date().toISOString());
      }
      db.close();
      const upgraded = createDatabase(file);
      try {
        const rows = upgraded
          .prepare("SELECT project_id, retained_after FROM project_sequences ORDER BY project_id")
          .all();
        expect(rows).toEqual([
          { project_id: "empty", retained_after: 5 },
          { project_id: "interior", retained_after: 4 },
          { project_id: "prefix", retained_after: 3 },
          { project_id: "suffix", retained_after: 5 },
        ]);
        const backup = path.join(directory, "backup.sqlite");
        backupDatabase(upgraded, backup);
        const restored = createDatabase(backup);
        try {
          expect(
            restored
              .prepare(
                "SELECT project_id, retained_after FROM project_sequences ORDER BY project_id",
              )
              .all(),
          ).toEqual(rows);
          expect(restored.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally {
          restored.close();
        }
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
  it("does not silently report a complete inbox after history is removed", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Retention", "owner").project;
      const session = app.ctx.sessionService.joinProject(project.project_id, "agent", "owner");
      const headers = {
        authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
      };
      app.ctx.eventBus.pruneEventsBefore("9999-01-01T00:00:00.000Z");
      const response = await app.inject({
        url: `/v1/projects/${project.project_id}/inbox?session_id=${session.session_id}&after=${encodeCursor(0)}`,
        headers,
      });
      expect(response.statusCode).toBe(410);
      expect(response.json().error.code).toBe("CURSOR_EXPIRED");
      expect(app.ctx.sessionService.getSessionById(session.session_id).last_cursor).toBe(
        encodeCursor(0),
      );
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("rejects concurrent joins with the same name while allowing independent agent names", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Concurrent", "owner").project;
      const first = app.ctx.sessionService.joinProject(project.project_id, "agent", "owner");
      expect(() =>
        app.ctx.sessionService.joinProject(project.project_id, "agent", "owner"),
      ).toThrow("STATE_CONFLICT");
      const second = app.ctx.sessionService.joinProject(project.project_id, "other-agent", "owner");
      app.ctx.sessionService.disconnect(project.project_id, first.agent_id);
      expect(
        app.ctx.sessionService.validateSessionForUser(
          second.session_id,
          "owner",
          project.project_id,
        ).status,
      ).toBe("active");
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
});
