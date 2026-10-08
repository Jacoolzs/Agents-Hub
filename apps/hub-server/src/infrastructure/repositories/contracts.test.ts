import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { SqliteLockRepository } from "./sqlite-lock-repository.js";
import { SqliteMessageRepository } from "./sqlite-message-repository.js";
import { SqliteSessionRepository } from "./sqlite-session-repository.js";
import { SqliteStatusRepository } from "./sqlite-status-repository.js";

describe("SQLite repository contracts and unit of work", () => {
  it("rolls back implicit user provisioning if project insertion fails", async () => {
    const app = buildApp();
    try {
      app.ctx.db.exec(
        "CREATE TEMP TRIGGER reject_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'project unavailable'); END;",
      );
      expect(() => app.ctx.projectService.createProject("Rollback", "new-user")).toThrow(
        "project unavailable",
      );
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(0);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(0);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships").get()?.n).toBe(0);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("rolls back invitation consumption and membership when audit fails", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Invite", "owner").project.project_id;
      const friend = crypto.randomUUID();
      app.ctx.db
        .prepare("INSERT INTO users VALUES (?, ?, ?)")
        .run(friend, "friend", new Date().toISOString());
      const invitation = app.ctx.membershipService.createInvitation(
        "owner",
        project,
        {},
        "issue-invite",
      );
      const max = app.ctx.eventBus.getMaxSequence(project);
      app.ctx.db.exec(
        "CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON audit_entries WHEN NEW.action = 'invitation.accept' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
      );
      expect(() =>
        app.ctx.membershipService.acceptInvitation(
          friend,
          project,
          invitation.token,
          "accept-invite",
        ),
      ).toThrow("audit unavailable");
      expect(
        app.ctx.membershipService.listInvitations("owner", project)[0]?.consumed_at,
      ).toBeNull();
      expect(app.ctx.membershipService.listMembers("owner", project)).toHaveLength(1);
      expect(app.ctx.eventBus.getMaxSequence(project)).toBe(max);
      app.ctx.db.exec("DROP TRIGGER reject_audit");
      app.ctx.membershipService.acceptInvitation(
        friend,
        project,
        invitation.token,
        "accept-invite",
      );
      expect(app.ctx.membershipService.listMembers("owner", project)).toHaveLength(2);
      expect(() =>
        app.ctx.membershipService.acceptInvitation(
          friend,
          project,
          invitation.token,
          "retry-invite",
        ),
      ).toThrow("Already a member");
      expect(
        app.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'invitation.accept'")
          .get()?.n,
      ).toBe(1);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });
  it("roundtrips sessions and locks with project isolation and monotonic checkpoints", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("Sessions", "owner").project.project_id;
      const other = app.ctx.projectService.createProject("Other", "owner").project.project_id;
      const session = app.ctx.sessionService.joinProject(project, "agent", "owner");
      const sessions = new SqliteSessionRepository(app.ctx.db);
      expect(sessions.findByAgent(project, "agent")).toEqual(session);
      expect(sessions.findByAgent(other, "agent")).toBeUndefined();
      expect(sessions.findById(session.session_id)).toEqual(session);
      const cursor = session.last_cursor ?? "MA";
      sessions.confirmCursor(project, "agent", "Mg", 2);
      sessions.confirmCursor(project, "agent", cursor, 0);
      expect(sessions.findById(session.session_id)?.last_cursor).toBe("Mg");
      const locks = new SqliteLockRepository(app.ctx.db);
      const lock = app.ctx.lockService.claimLock(project, "agent", {
        paths: ["src/a", "src/b"],
        reason: "Work",
        ttl_seconds: 300,
      });
      expect(locks.findById(project, lock.lock_id)).toEqual(lock);
      expect(locks.findById(other, lock.lock_id)).toBeUndefined();
      locks.updatePaths(lock.lock_id, ["src/b"]);
      expect(locks.findById(project, lock.lock_id)?.paths).toEqual(["src/b"]);
      locks.renew(lock.lock_id, "2000-01-01T00:00:00.000Z", 1);
      expect(locks.activeByProject(project, new Date().toISOString())).toEqual([]);
      expect(locks.expired(new Date().toISOString(), other)).toEqual([]);
      expect(locks.expired(new Date().toISOString(), project).map((lock) => lock.lock_id)).toEqual([
        lock.lock_id,
      ]);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  for (const release of [false, true]) {
    it(`keeps a lock unchanged if ${release ? "release" : "renewal"} auditing fails and retries once`, async () => {
      const app = buildApp();
      try {
        const project = app.ctx.projectService.createProject("Locks", "owner").project.project_id;
        const session = app.ctx.sessionService.joinProject(project, "agent", "owner");
        const lock = app.ctx.lockService.claimLock(project, "agent", {
          paths: ["src/a"],
          reason: "Work",
          ttl_seconds: 100,
        });
        const action = release ? "lock.release" : "lock.renew";
        const max = app.ctx.eventBus.getMaxSequence(project);
        app.ctx.db.exec(
          `CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON audit_entries WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`,
        );
        const send = () =>
          app.inject({
            method: release ? "DELETE" : "POST",
            url: `/v1/projects/${project}/locks/${lock.lock_id}${release ? "" : "/renew"}`,
            headers: {
              authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
              "idempotency-key": "lock-command",
            },
            payload: { session_id: session.session_id, ...(release ? {} : { ttl_seconds: 300 }) },
          });
        expect((await send()).statusCode).toBe(500);
        expect(app.ctx.lockService.getActiveLocks(project)).toEqual([lock]);
        expect(app.ctx.eventBus.getMaxSequence(project)).toBe(max);
        expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM idempotency_records").get()?.n).toBe(
          0,
        );
        app.ctx.db.exec("DROP TRIGGER reject_audit");
        const first = await send();
        expect(first.statusCode).toBe(200);
        expect((await send()).json().data).toEqual(first.json().data);
        expect(
          app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = ?").get(action)
            ?.n,
        ).toBe(1);
        expect(app.ctx.eventBus.getMaxSequence(project)).toBe(max + 1);
        expect(app.ctx.lockService.getActiveLocks(project).length).toBe(release ? 0 : 1);
      } finally {
        await app.close();
        app.ctx.db.close();
      }
    });
  }
  it("roundtrips optional values and isolates project/channel/latest status queries", async () => {
    const app = buildApp();
    try {
      const project = app.ctx.projectService.createProject("First", "owner").project.project_id;
      const other = app.ctx.projectService.createProject("Other", "owner").project.project_id;
      app.ctx.sessionService.joinProject(project, "recipient", "owner");
      const messages = new SqliteMessageRepository(app.ctx.db);
      expect(messages.recipientExists(project, "recipient")).toBe(true);
      expect(messages.recipientExists(other, "recipient")).toBe(false);
      const message = app.ctx.messageService.sendMessage(project, "sender", {
        body: "Public",
        channel: "general",
        priority: "high",
      });
      const correlated = app.ctx.messageService.sendMessage(project, "sender", {
        body: "Directed",
        channel: "contracts",
        priority: "normal",
        recipient_agent_ids: ["recipient"],
        correlation_id: crypto.randomUUID(),
      });
      expect(messages.listByProject(project, "general", 50)).toEqual([message]);
      expect(messages.listByProject(project, "contracts", 50)).toEqual([correlated]);
      expect(messages.listByProject(other, undefined, 50)).toEqual([]);
      app.ctx.statusService.reportStatus(project, "sender", {
        objective: "Before",
        progress: "started",
      });
      const latest = app.ctx.statusService.reportStatus(project, "sender", {
        objective: "After",
        progress: "blocked",
        blocked_by: "Review needed",
        decision: "Keep contract",
        next_step: "Await review",
      });
      const statuses = new SqliteStatusRepository(app.ctx.db);
      expect(statuses.latestByProject(project)).toEqual([latest]);
      expect(statuses.latestByProject(other)).toEqual([]);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  for (const [operation, route, table, payload, eventType] of [
    ["message.create", "messages", "messages", { body: "Atomic message" }, "message.created"],
    ["status.report", "status", "status_reports", { objective: "Atomic status" }, "status.updated"],
    [
      "lock.claim",
      "locks/claim",
      "workspace_locks",
      { paths: ["src/atomic"], reason: "Atomic lock" },
      "lock.acquired",
    ],
  ] as const) {
    it(`rolls back ${operation}, event, audit and idempotency when the audit adapter fails`, async () => {
      const app = buildApp();
      try {
        const project = app.ctx.projectService.createProject("Atomic", "owner").project.project_id;
        const session = app.ctx.sessionService.joinProject(project, "agent", "owner");
        const max = app.ctx.eventBus.getMaxSequence(project);
        const dispatched: string[] = [];
        app.ctx.eventBus.subscribe((event) => dispatched.push(event.type));
        app.ctx.db.exec(`CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON audit_entries
          WHEN NEW.action = '${operation}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
        const send = () =>
          app.inject({
            method: "POST",
            url: `/v1/projects/${project}/${route}`,
            headers: {
              authorization: `Bearer ${app.ctx.authService.createToken("owner", "agents-hub")}`,
              "idempotency-key": "atomic-command",
            },
            payload: { session_id: session.session_id, ...payload },
          });
        expect((await send()).statusCode).toBe(500);
        expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
        expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM idempotency_records").get()?.n).toBe(
          0,
        );
        expect(
          app.ctx.db
            .prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = ?")
            .get(operation)?.n,
        ).toBe(0);
        expect(app.ctx.eventBus.getMaxSequence(project)).toBe(max);
        expect(dispatched).toEqual([]);
        app.ctx.db.exec("DROP TRIGGER reject_audit");
        const first = await send();
        expect(first.statusCode).toBe(201);
        expect((await send()).json().data).toEqual(first.json().data);
        expect(app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
        expect(
          app.ctx.db
            .prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = ?")
            .get(operation)?.n,
        ).toBe(1);
        expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM idempotency_records").get()?.n).toBe(
          1,
        );
        expect(dispatched).toEqual([eventType]);
      } finally {
        await app.close();
        app.ctx.db.close();
      }
    });
  }
});
