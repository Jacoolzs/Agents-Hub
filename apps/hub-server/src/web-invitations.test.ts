import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BROWSER_AUDIENCE } from "@agents-hub/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";
import { buildLocalControl } from "./local/control-app.js";

const headers = { host: "127.0.0.1:8795", origin: "http://127.0.0.1:8795" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const app = buildApp({ CORS_ORIGINS: headers.origin });
  cleanup.push(async () => {
    await app.close();
    app.ctx.db.close();
  });
  const owner = crypto.randomUUID();
  const project = app.ctx.projectService.createProject("Invited project", owner, "host").project
    .project_id;
  const service = app.ctx.webAccessService;
  const invite = (username = "friend", role = "collaborator") =>
    service.issueInvitation(
      { project_id: project, person: { kind: "new", username }, role },
      "issue",
    );
  const post = (url: string, secret: string) =>
    app.inject({ method: "POST", url, headers, payload: { secret } });
  return { app, owner, project, service, invite, post };
}

describe("bound human invitations", () => {
  it("reserves an identity without MCP credentials or permission until explicit exchange, exactly once", async () => {
    const f = fixture();
    const entry = f.invite();
    const invitation = f.service.listInvitations()[0];
    expect(invitation?.username).toBe("friend");
    const user = invitation?.user_id;
    expect(
      f.app.ctx.db.prepare("SELECT 1 FROM memberships WHERE user_id = ?").get(user),
    ).toBeUndefined();
    expect(
      f.app.ctx.db.prepare("SELECT 1 FROM auth_tokens WHERE subject = ?").get(user),
    ).toBeUndefined();
    const before = f.app.ctx.db.prepare("SELECT COUNT(*) n FROM events").get()?.n;
    const preview = await f.post("/v1/web/entry/preview", entry.secret);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["set-cookie"]).toBeUndefined();
    expect(preview.json().data.project.role).toBe("collaborator");
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(before);
    const responses = await Promise.all([
      f.post("/v1/web/entry", entry.secret),
      f.post("/v1/web/entry", entry.secret),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(
      f.app.ctx.db.prepare("SELECT role FROM memberships WHERE user_id = ?").get(user)?.role,
    ).toBe("collaborator");
    expect(
      f.app.ctx.db
        .prepare("SELECT COUNT(*) n FROM auth_tokens WHERE subject = ? AND audience = ?")
        .get(user, BROWSER_AUDIENCE)?.n,
    ).toBe(1);
    expect(
      f.app.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'membership.updated'").get()
        ?.n,
    ).toBe(1);
    expect(f.service.listInvitations()[0]?.consumed_at).not.toBeNull();
    expect(JSON.stringify(f.service.listInvitations())).not.toContain(entry.secret);
    expect(JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM web_entries").all())).not.toContain(
      entry.secret,
    );
    expect(() => f.service.revokeInvitation(entry.entry_id, "too-late")).toThrow();
  });

  it("requires explicit existing identity, rejects membership escalation and invalid roles/durations", () => {
    const f = fixture();
    f.invite();
    const user = f.service.listInvitations()[0]?.user_id;
    const input = {
      project_id: f.project,
      person: { kind: "existing", user_id: user },
      role: "reader",
    };
    expect(() => f.invite()).toThrow(/ya existe/);
    const second = f.service.issueInvitation(input, "selected");
    expect(f.service.preview({ secret: second.secret }).user.user_id).toBe(user);
    for (const bad of [
      { ...input, role: "owner" },
      { ...input, ttl_seconds: 0 },
      { ...input, ttl_seconds: 604801 },
      { ...input, person: { kind: "existing", user_id: "friend" } },
      { ...input, person: { kind: "new", username: "friend", user_id: user } },
    ]) {
      expect(() => f.service.issueInvitation(bad, "bad")).toThrow();
    }
    f.service.exchange({ secret: second.secret }, "accept");
    expect(() => f.service.issueInvitation(input, "already-member")).toThrow(/ya pertenece/);
    const first = f.app.ctx.db
      .prepare("SELECT entry_id FROM web_entries WHERE entry_id <> ?")
      .get(second.entry_id)?.entry_id as string;
    expect(first).toBeTruthy();
    expect(
      f.app.ctx.db.prepare("SELECT role FROM memberships WHERE user_id = ?").get(user)?.role,
    ).toBe("reader");
  });

  it("rejects expired/revoked links and conflicting membership without silently changing role", async () => {
    const f = fixture();
    const revoked = f.invite("revoked");
    f.service.revokeInvitation(revoked.entry_id, "revoke");
    expect((await f.post("/v1/web/entry/preview", revoked.secret)).statusCode).toBe(401);
    expect((await f.post("/v1/web/entry", revoked.secret)).statusCode).toBe(401);
    const expired = f.invite("expired");
    f.app.ctx.db
      .prepare("UPDATE web_entries SET expires_at = ? WHERE entry_id = ?")
      .run(new Date(Date.now() - 1).toISOString(), expired.entry_id);
    expect((await f.post("/v1/web/entry", expired.secret)).statusCode).toBe(401);
    expect((await f.post("/v1/web/entry/preview", expired.secret)).statusCode).toBe(401);
    expect(
      f.app.ctx.db
        .prepare(
          "SELECT COUNT(*) n FROM memberships WHERE user_id IN (SELECT user_id FROM users WHERE username IN ('revoked', 'expired'))",
        )
        .get()?.n,
    ).toBe(0);
    const conflict = f.invite("conflict", "maintainer");
    const user = f.service.listInvitations().find((i) => i.entry_id === conflict.entry_id)?.user_id;
    f.app.ctx.db
      .prepare("INSERT INTO memberships VALUES (?, ?, ?, 'reader', ?)")
      .run(crypto.randomUUID(), f.project, user, new Date().toISOString());
    expect((await f.post("/v1/web/entry/preview", conflict.secret)).statusCode).toBe(409);
    expect((await f.post("/v1/web/entry", conflict.secret)).statusCode).toBe(409);
    expect(
      f.app.ctx.db
        .prepare("SELECT consumed_at FROM web_entries WHERE entry_id = ?")
        .get(conflict.entry_id)?.consumed_at,
    ).toBeNull();
    expect(
      f.app.ctx.db.prepare("SELECT role FROM memberships WHERE user_id = ?").get(user)?.role,
    ).toBe("reader");
  });

  it("rolls back provision/consumption/membership/session/event on audit failure and retries without duplicates", async () => {
    const f = fixture();
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_issue BEFORE INSERT ON audit_entries WHEN NEW.action = 'web.invitation.issue' BEGIN SELECT RAISE(ABORT, 'fail'); END;",
    );
    expect(() => f.invite("rolled-back")).toThrow();
    expect(
      f.app.ctx.db.prepare("SELECT 1 FROM users WHERE username = 'rolled-back'").get(),
    ).toBeUndefined();
    expect(f.service.listInvitations()).toHaveLength(0);
    f.app.ctx.db.exec("DROP TRIGGER fail_issue;");
    const entry = f.invite();
    const user = f.service.listInvitations()[0]?.user_id;
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_revoke BEFORE INSERT ON audit_entries WHEN NEW.action = 'web.invitation.revoke' BEGIN SELECT RAISE(ABORT, 'fail'); END;",
    );
    expect(() => f.service.revokeInvitation(entry.entry_id, "revoke-rollback")).toThrow();
    expect(f.service.listInvitations()[0]?.revoked_at).toBeNull();
    f.app.ctx.db.exec("DROP TRIGGER fail_revoke;");
    const events: string[] = [];
    const unsubscribe = f.app.ctx.eventBus.subscribe((event) => events.push(event.type));
    try {
      f.app.ctx.db.exec(
        "CREATE TRIGGER fail_session BEFORE INSERT ON audit_entries WHEN NEW.action = 'web.session.start' BEGIN SELECT RAISE(ABORT, 'fail'); END;",
      );
      expect((await f.post("/v1/web/entry", entry.secret)).statusCode).toBe(500);
      expect(events).toEqual([]);
      expect(
        f.app.ctx.db.prepare("SELECT 1 FROM memberships WHERE user_id = ?").get(user),
      ).toBeUndefined();
      expect(
        f.app.ctx.db.prepare("SELECT 1 FROM auth_tokens WHERE subject = ?").get(user),
      ).toBeUndefined();
      expect(
        f.app.ctx.db
          .prepare("SELECT consumed_at FROM web_entries WHERE entry_id = ?")
          .get(entry.entry_id)?.consumed_at,
      ).toBeNull();
      f.app.ctx.db.exec("DROP TRIGGER fail_session;");
      expect((await f.post("/v1/web/entry", entry.secret)).statusCode).toBe(200);
      expect(events).toEqual(["membership.updated"]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps invitation management exclusively on the authenticated local listener", async () => {
    const f = fixture();
    const control = buildLocalControl(
      {
        context: () => f.app.ctx,
        status: () => ({ hub: "running", sharing: "stopped", portal_url: headers.origin }),
        start: async () => {},
        stop: async () => {},
        share: async () => {},
        stopSharing: async () => {},
      },
      "http://127.0.0.1:8791",
    );
    cleanup.push(async () => {
      await control.app.close();
    });
    const localHeaders = { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791" };
    const input = {
      project_id: f.project,
      person: { kind: "new", username: "local-friend" },
      role: "reader",
    };
    expect(
      (
        await control.app.inject({
          method: "POST",
          url: "/local-api/web-invitations",
          headers: localHeaders,
          payload: input,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await f.app.inject({ method: "POST", url: "/local-api/web-invitations", payload: input }))
        .statusCode,
    ).toBe(404);
    const secret = new URLSearchParams(new URL(control.bootstrapUrl).hash.slice(1)).get(
      "local-control",
    );
    const bootstrap = await control.app.inject({
      method: "POST",
      url: "/local-api/bootstrap",
      headers: localHeaders,
      payload: { secret },
    });
    const cookie = String(bootstrap.headers["set-cookie"]).split(";")[0] as string;
    const auth = { ...localHeaders, cookie };
    const result = await control.app.inject({
      method: "POST",
      url: "/local-api/web-invitations",
      headers: auth,
      payload: input,
    });
    expect(result.statusCode).toBe(200);
    const list = await control.app.inject({
      method: "GET",
      url: "/local-api/web-invitations",
      headers: auth,
    });
    expect(list.json()).toHaveLength(1);
    expect(list.body).not.toContain(result.json().secret);
    expect(
      (
        await control.app.inject({
          method: "DELETE",
          url: `/local-api/web-invitations/${result.json().entry_id}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.post("/v1/web/entry", result.json().secret)).statusCode).toBe(401);
  });

  it("upgrades schema8 entries and retains pending invitations and one-use consumption through disk backup", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-bound-invite-"));
    const file = path.join(directory, "old.sqlite");
    const backup = path.join(directory, "snapshot.sqlite");
    let db: DatabaseSync | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      db = new DatabaseSync(file);
      db.exec(
        "BEGIN IMMEDIATE; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
      );
      for (const migration of MIGRATIONS.filter((m) => m.version <= 8)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      }
      const user = crypto.randomUUID();
      const project = crypto.randomUUID();
      const oldEntry = crypto.randomUUID();
      const date = new Date().toISOString();
      db.prepare("INSERT INTO users VALUES (?, 'host', ?)").run(user, date);
      db.prepare("INSERT INTO projects VALUES (?, 'Old project', ?, ?, ?)").run(
        project,
        user,
        date,
        date,
      );
      db.prepare("INSERT INTO memberships VALUES (?, ?, ?, 'owner', ?)").run(
        crypto.randomUUID(),
        project,
        user,
        date,
      );
      db.prepare("INSERT INTO web_entries VALUES (?, 'legacy-hash', ?, ?, ?, ?, NULL, NULL)").run(
        oldEntry,
        user,
        project,
        date,
        date,
      );
      db.exec("COMMIT;");
      db.close();
      db = undefined;
      db = createDatabase(file);
      expect(
        db.prepare("SELECT pending_role FROM web_entries WHERE entry_id = ?").get(oldEntry)
          ?.pending_role,
      ).toBeNull();
      app = buildApp({}, db);
      const entry = app.ctx.webAccessService.issueInvitation(
        {
          project_id: project,
          person: { kind: "new", username: "restored-friend" },
          role: "reader",
        },
        "issue",
      );
      await app.close();
      app = undefined;
      backupDatabase(db, backup);
      db.close();
      db = undefined;
      db = createDatabase(backup);
      app = buildApp({}, db);
      expect(app.ctx.webAccessService.preview({ secret: entry.secret }).project.role).toBe(
        "reader",
      );
      const accepted = app.ctx.webAccessService.exchange({ secret: entry.secret }, "accept");
      expect(accepted.profile.user.username).toBe("restored-friend");
      await app.close();
      app = undefined;
      db.close();
      db = undefined;
      db = createDatabase(backup);
      app = buildApp({}, db);
      expect(() => app?.ctx.webAccessService.exchange({ secret: entry.secret }, "reuse")).toThrow();
      expect(app.ctx.authService.verifyToken(accepted.secret, BROWSER_AUDIENCE).userId).toBe(
        accepted.profile.user.user_id,
      );
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      await app?.close();
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
