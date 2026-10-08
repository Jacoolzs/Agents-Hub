import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeCursor } from "@agents-hub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "../../../packages/mcp-server/src/client/hub-client.js";
import { runAdmin } from "./admin.js";
import { buildApp } from "./app.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { INITIAL_MIGRATION_SQL } from "./infrastructure/db/migrations.js";

const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    app.ctx.db.close();
  }
  for (const dir of directories.splice(0)) {
    if (!path.resolve(dir).startsWith(path.join(tmpdir(), "agents-hub-")))
      throw new Error("Unexpected test directory");
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup() {
  const app = buildApp();
  apps.push(app);
  const owner = crypto.randomUUID();
  const project = app.ctx.projectService.createProject("Friends", owner).project.project_id;
  const token = app.ctx.authService.createToken(owner, "agents-hub");
  const root = `/v1/projects/${project}`;
  function provision(name: string, role?: string) {
    const id = crypto.randomUUID();
    app.ctx.db
      .prepare("INSERT INTO users VALUES (?, ?, ?)")
      .run(id, name, new Date().toISOString());
    if (role)
      app.ctx.db
        .prepare("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), project, id, role, new Date().toISOString());
    return { id, token: app.ctx.authService.createToken(id, "agents-hub") };
  }
  const request = (
    token: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { app, owner, project, token, root, provision, request };
}
describe("Multiuser and operational acceptance", () => {
  it("renews with one result after a lost response, enforces ownership and rejects expired locks", async () => {
    const { app, owner, project, token, root, provision, request } = setup();
    const friend = provision("renew-friend", "collaborator");
    const stranger = provision("renew-stranger", "collaborator");
    const friendSession = app.ctx.sessionService.joinProject(project, "friend", friend.id);
    const otherSession = app.ctx.sessionService.joinProject(project, "stranger", stranger.id);
    const ownerSession = app.ctx.sessionService.joinProject(project, "owner", owner);
    const lock = app.ctx.lockService.claimLock(project, "friend", {
      paths: ["src/renew"],
      reason: "Work",
      ttl_seconds: 60,
    });
    const denied = await request(stranger.token, "POST", `${root}/locks/${lock.lock_id}/renew`, {
      session_id: otherSession.session_id,
      ttl_seconds: 300,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("LOCK_NOT_OWNER");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const client = new HubClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: friend.token,
    });
    const realFetch = globalThis.fetch;
    let attempts = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (String(input).endsWith("/renew") && ++attempts === 1) {
        await response.arrayBuffer();
        throw new TypeError("Lost renewal response", {
          cause: Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }),
        });
      }
      return response;
    });
    try {
      const renewed = await client.renewLock(
        project,
        friendSession.session_id,
        lock.lock_id,
        300,
        "renew-retry",
      );
      expect(attempts).toBe(2);
      expect(renewed.ttl_seconds).toBe(300);
      expect(
        app.ctx.db
          .prepare("SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'lock.renew'")
          .get()?.n,
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const override = await request(token, "POST", `${root}/locks/${lock.lock_id}/renew`, {
      session_id: ownerSession.session_id,
      ttl_seconds: 600,
      idempotency_key: "owner-renew",
    });
    expect(override.statusCode).toBe(200);
    app.ctx.db
      .prepare("UPDATE workspace_locks SET expires_at = ? WHERE lock_id = ?")
      .run("2000-01-01T00:00:00.000Z", lock.lock_id);
    const expired = await request(friend.token, "POST", `${root}/locks/${lock.lock_id}/renew`, {
      session_id: friendSession.session_id,
      ttl_seconds: 300,
      idempotency_key: "new-after-expiry",
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.code).toBe("LOCK_CONFLICT");
  });

  it("retries a lost HTTP response after commit using one stable idempotency key", async () => {
    const { app, owner, project, token } = setup();
    const session = app.ctx.sessionService.joinProject(project, "retry-agent", owner);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const client = new HubClient({ baseUrl: `http://127.0.0.1:${address.port}`, token });
    const original = globalThis.fetch;
    let attempts = 0;
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/messages") && ++attempts === 1) {
        await response.arrayBuffer();
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("Lost committed response"), { code: "ECONNRESET" }),
        });
      }
      return response;
    });
    try {
      const result = await client.sendMessage(
        project,
        session.session_id,
        { body: "Exactly one persisted message" },
        "lost-real-response",
      );
      expect(result).toMatchObject({ body: "Exactly one persisted message" });
      expect(attempts).toBe(2);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(1);
      expect(
        app.ctx.eventBus.getEventsAfter(project).filter((e) => e.type === "message.created"),
      ).toHaveLength(1);
    } finally {
      mock.mockRestore();
    }
  });
  it("shares the verified-user quota between two personal tokens", async () => {
    const app = buildApp({ RATE_LIMIT_USER_PER_MINUTE: 2 });
    apps.push(app);
    const user = crypto.randomUUID();
    const project = app.ctx.projectService.createProject("Quota", user).project.project_id;
    const tokens = [
      app.ctx.authService.createToken(user, "agents-hub"),
      app.ctx.authService.createToken(user, "agents-hub"),
    ];
    const responses = [];
    for (const token of [...tokens, tokens[0]])
      responses.push(
        await app.inject({
          method: "GET",
          url: `/v1/projects/${project}`,
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 429]);
  });
  it("upgrades a legacy database preserving sessions, ACK and event sequence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-legacy-"));
    directories.push(directory);
    const file = path.join(directory, "legacy.sqlite");
    const db = new DatabaseSync(file);
    db.exec(INITIAL_MIGRATION_SQL);
    const user = crypto.randomUUID();
    const project = crypto.randomUUID();
    const session = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(user, "legacy", now);
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(
      project,
      "Legacy",
      user,
      now,
      now,
    );
    db.prepare("INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      session,
      "legacy-agent",
      project,
      user,
      "active",
      encodeCursor(7),
      now,
      now,
    );
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      crypto.randomUUID(),
      project,
      7,
      "agent.joined",
      "legacy-agent",
      now,
      1,
      "{}",
    );
    db.close();
    const app = buildApp({ DATABASE_URL: file });
    apps.push(app);
    expect(app.ctx.sessionService.getSessionById(session).last_cursor).toBe(encodeCursor(7));
    app.ctx.sessionService.updateCursor(project, "legacy-agent", encodeCursor(3));
    expect(app.ctx.sessionService.getSessionById(session).last_cursor).toBe(encodeCursor(7));
    expect(
      app.ctx.eventBus.recordEvent(project, "legacy-agent", "agent.heartbeat", {}).sequence,
    ).toBe(8);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(6);
  });
  it("stores only invite hashes; accepts once, expires, revokes and isolates projects", async () => {
    const { app, owner, project, token, root, provision, request } = setup();
    const friend = provision("friend");
    const other = provision("other");
    const invitation = (
      await request(token, "POST", `${root}/invitations`, { role: "collaborator", ttl_seconds: 60 })
    ).json().data;
    expect(JSON.stringify(app.ctx.db.prepare("SELECT * FROM invitations").all())).not.toContain(
      invitation.token,
    );
    const accepts = await Promise.all(
      [friend, other].map((user) =>
        request(user.token, "POST", `${root}/invitations/accept`, { token: invitation.token }),
      ),
    );
    expect(accepts.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const second = (await request(token, "POST", `${root}/invitations`, { role: "reader" })).json()
      .data;
    await request(token, "DELETE", `${root}/invitations/${second.invitation_id}`);
    expect(
      (await request(other.token, "POST", `${root}/invitations/accept`, { token: second.token }))
        .statusCode,
    ).toBe(401);
    const third = (await request(token, "POST", `${root}/invitations`, { role: "reader" })).json()
      .data;
    const otherProject = app.ctx.projectService.createProject("Other project", owner).project
      .project_id;
    expect(
      (
        await request(other.token, "POST", `/v1/projects/${otherProject}/invitations/accept`, {
          token: third.token,
        })
      ).statusCode,
    ).toBe(401);
    app.ctx.db
      .prepare(
        "UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE invitation_id = ?",
      )
      .run(third.invitation_id);
    expect(
      (await request(other.token, "POST", `${root}/invitations/accept`, { token: third.token }))
        .statusCode,
    ).toBe(401);
    expect(app.ctx.membershipService.listMembers(owner, project)).toHaveLength(2);
    expect(JSON.stringify(app.ctx.db.prepare("SELECT * FROM audit_entries").all())).not.toContain(
      invitation.token,
    );
  });
  it("intersects scopes/roles and permits reader presence but prevents maintainer escalation", async () => {
    const { app, owner, project, token, root, provision, request } = setup();
    const reader = provision("reader", "reader");
    const collaborator = provision("collab", "collaborator");
    const maintainer = provision("maintainer", "maintainer");
    for (const user of [reader, collaborator, maintainer]) {
      const joined = await request(user.token, "POST", `${root}/sessions`, { agent_id: user.id });
      expect(joined.statusCode).toBe(201);
      const session = joined.json().data;
      expect(
        (
          await request(user.token, "POST", `/v1/sessions/${session.session_id}/heartbeat`, {
            project_id: project,
            agent_id: user.id,
          })
        ).statusCode,
      ).toBe(200);
      const msg = await request(user.token, "POST", `${root}/messages`, {
        session_id: session.session_id,
        body: "hello",
      });
      expect(msg.statusCode).toBe(user === reader ? 403 : 201);
      expect(
        (await request(user.token, "POST", `${root}/invitations`, { role: "reader" })).statusCode,
      ).toBe(user === maintainer ? 201 : 403);
    }
    expect(
      (await request(maintainer.token, "POST", `${root}/invitations`, { role: "maintainer" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await request(maintainer.token, "PATCH", `${root}/members/${collaborator.id}`, {
          role: "maintainer",
        })
      ).statusCode,
    ).toBe(403);
    expect((await request(maintainer.token, "DELETE", `${root}/members/${owner}`)).statusCode).toBe(
      403,
    );
    expect((await request(token, "DELETE", `${root}/members/${owner}`)).statusCode).toBe(403);
    const readOnly = app.ctx.authService.createToken(collaborator.id, "agents-hub", [
      "members:read",
    ]);
    expect(
      (await request(readOnly, "POST", `${root}/invitations`, { role: "reader" })).statusCode,
    ).toBe(403);
    expect(
      (await request(token, "POST", `${root}/ownership`, { user_id: collaborator.id })).statusCode,
    ).toBe(200);
    expect(app.ctx.authService.checkProjectPermission(owner, project)).toBe("maintainer");
    expect(app.ctx.authService.checkProjectPermission(collaborator.id, project)).toBe("owner");
    expect(
      app.ctx.db
        .prepare("SELECT created_by_user_id FROM projects WHERE project_id = ?")
        .get(project)?.created_by_user_id,
    ).toBe(owner);
  });
  it("allows owner lock override, retires removed sessions and enforces project-bound token administration", async () => {
    const { app, owner, project, token, root, provision, request } = setup();
    const friend = provision("friend", "collaborator");
    const session = app.ctx.sessionService.joinProject(project, "friend", friend.id);
    const ownerSession = app.ctx.sessionService.joinProject(project, "owner", owner);
    const lock = app.ctx.lockService.claimLock(project, "friend", {
      paths: ["src/api"],
      reason: "edit",
    });
    expect(
      (
        await request(token, "POST", `${root}/locks/${lock.lock_id}/renew`, {
          session_id: ownerSession.session_id,
          ttl_seconds: 60,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(token, "DELETE", `${root}/locks/${lock.lock_id}`, {
          session_id: ownerSession.session_id,
        })
      ).statusCode,
    ).toBe(200);
    const restricted = app.ctx.authService.createToken(owner, "agents-hub", ["*"], 3600, project);
    const fullId = app.ctx.authService.verifyToken(token).tokenId;
    expect(
      (await request(restricted, "GET", "/v1/tokens"))
        .json()
        .data.some((t: { token_id: string }) => t.token_id === fullId),
    ).toBe(false);
    expect((await request(restricted, "DELETE", `/v1/tokens/${fullId}`)).statusCode).toBe(403);
    expect((await request(token, "DELETE", `${root}/members/${friend.id}`)).statusCode).toBe(200);
    expect(app.ctx.sessionService.getSessionById(session.session_id).status).toBe("disconnected");
    expect((await request(friend.token, "GET", `${root}/team-status`)).statusCode).toBe(403);
  });
  it("transitions active sessions to idle/disconnected once", () => {
    const { app, owner, project } = setup();
    const session = app.ctx.sessionService.joinProject(project, "agent", owner);
    app.ctx.db
      .prepare("UPDATE agent_sessions SET last_seen_at = ? WHERE session_id = ?")
      .run(new Date(Date.now() - 70000).toISOString(), session.session_id);
    app.ctx.sessionService.expireSessions();
    app.ctx.sessionService.expireSessions();
    expect(app.ctx.sessionService.getSessionById(session.session_id).status).toBe("idle");
    app.ctx.db.prepare("UPDATE agent_sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'").run();
    app.ctx.sessionService.expireSessions();
    app.ctx.sessionService.expireSessions();
    const events = app.ctx.eventBus.getEventsAfter(project);
    expect(events.filter((e) => e.type === "agent.idle")).toHaveLength(1);
    expect(events.filter((e) => e.type === "agent.left")).toHaveLength(1);
  });
  it("restores an intact backup to a new DB; retains ACK and idempotency across restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-ops-"));
    directories.push(directory);
    const file = path.join(directory, "source.sqlite");
    const backup = path.join(directory, "backup.sqlite");
    const restored = path.join(directory, "restored.sqlite");
    let app = buildApp({ DATABASE_URL: file });
    apps.push(app);
    const owner = crypto.randomUUID();
    const project = app.ctx.projectService.createProject("Durable", owner).project.project_id;
    const session = app.ctx.sessionService.joinProject(project, "agent", owner);
    const token = app.ctx.authService.createToken(owner, "agents-hub");
    const request = {
      method: "POST" as const,
      url: `/v1/projects/${project}/messages`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "durable" },
      payload: { session_id: session.session_id, body: "Persisted" },
    };
    const original = await app.inject(request);
    const cursor = encodeCursor(app.ctx.eventBus.getMaxSequence(project));
    app.ctx.sessionService.updateCursor(project, "agent", cursor);
    backupDatabase(app.ctx.db, backup);
    runAdmin(["restore", backup, restored]);
    expect(() => runAdmin(["restore", backup, restored])).toThrow(/new/);
    await app.close();
    app.ctx.db.close();
    apps.pop();
    app = buildApp({ DATABASE_URL: restored });
    apps.push(app);
    expect(app.ctx.sessionService.getSessionById(session.session_id).last_cursor).toBe(cursor);
    expect((await app.inject(request)).json().data).toEqual(original.json().data);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(1);
    expect(app.ctx.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(6);
    expect(app.ctx.db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  });
});
