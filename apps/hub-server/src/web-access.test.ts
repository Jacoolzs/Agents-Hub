import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BROWSER_AUDIENCE, WebSessionSchema } from "@agents-hub/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";
import { buildLocalControl } from "./local/control-app.js";

const origin = "http://127.0.0.1:8795";
const headers = { host: "127.0.0.1:8795", origin, "sec-fetch-site": "same-origin" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(https = false) {
  const hostHeaders = https
    ? { host: "hub.example", origin: "https://hub.example", "sec-fetch-site": "same-origin" }
    : headers;
  const app = buildApp({ NODE_ENV: "production", CORS_ORIGINS: hostHeaders.origin });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    app.ctx.db.close();
  });
  const user = crypto.randomUUID();
  const project = app.ctx.projectService.createProject("Web project", user, "alice").project
    .project_id;
  const other = app.ctx.projectService.createProject("Other project", crypto.randomUUID(), "other")
    .project.project_id;
  const personal = app.ctx.authService.createToken(user, "agents-hub");
  const entry = () =>
    app.ctx.webAccessService.issueEntry(user, { project_id: project }, "test-issue");
  const exchange = (secret: string) =>
    app.inject({ method: "POST", url: "/v1/web/entry", headers: hostHeaders, payload: { secret } });
  const connect = async () => {
    const result = await exchange(entry().secret);
    expect(result.statusCode).toBe(200);
    const cookie = String(result.headers["set-cookie"]).split(";")[0] as string;
    return { cookie, result, auth: { ...hostHeaders, cookie } };
  };
  return { app, user, project, other, personal, entry, exchange, connect, hostHeaders };
}
describe("human web session core", () => {
  it("issues entries only through local authority, with no identity or membership inferred from public names", async () => {
    const f = await fixture();
    const control = buildLocalControl(
      {
        context: () => f.app.ctx,
        status: () => ({ hub: "running", sharing: "stopped", portal_url: origin }),
        start: async () => {},
        stop: async () => {},
        share: async () => {},
        stopSharing: async () => {},
      },
      "http://127.0.0.1:8791",
    );
    cleanups.push(async () => {
      await control.app.close();
    });
    const localHeaders = { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791" };
    const route = `/local-api/users/${f.user}/web-entry`;
    expect(
      (
        await control.app.inject({
          method: "POST",
          url: route,
          headers: { ...localHeaders, authorization: `Bearer ${f.personal}` },
          payload: { project_id: f.project },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: route,
          headers: { authorization: `Bearer ${f.personal}` },
          payload: { project_id: f.project },
        })
      ).statusCode,
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
    const issued = await control.app.inject({
      method: "POST",
      url: route,
      headers: { ...localHeaders, cookie },
      payload: { project_id: f.project },
    });
    expect(issued.statusCode).toBe(200);
    const accepted = await f.exchange(issued.json().secret);
    expect(accepted.statusCode).toBe(200);
    expect(WebSessionSchema.parse(accepted.json().data).user.user_id).toBe(f.user);
    expect(JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM web_entries").all())).not.toContain(
      issued.json().secret,
    );
    expect(() =>
      f.app.ctx.webAccessService.issueEntry(f.user, { project_id: f.other }, "test"),
    ).toThrow();
    expect((await f.exchange("alice")).statusCode).toBe(401);
    const preview = f.entry();
    const tokensBefore = f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n;
    const response = await f.app.inject({
      method: "POST",
      url: "/v1/web/entry/preview",
      headers,
      payload: { secret: preview.secret },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(WebSessionSchema.parse(response.json().data).user.username).toBe(
      f.app.ctx.db.prepare("SELECT username FROM users WHERE user_id = ?").get(f.user)?.username,
    );
    expect(response.body).not.toContain(preview.secret);
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n).toBe(tokensBefore);
    expect(
      f.app.ctx.db
        .prepare("SELECT consumed_at FROM web_entries WHERE entry_id = ?")
        .get(preview.entry_id)?.consumed_at,
    ).toBeNull();
    expect((await f.exchange(preview.secret)).statusCode).toBe(200);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/web/entry/preview",
          headers,
          payload: { secret: preview.secret },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("uses host-prefixed secure cookies on HTTPS, separate audience, scope and project fences", async () => {
    const f = await fixture(true);
    const { result, cookie, auth } = await f.connect();
    const setCookie = String(result.headers["set-cookie"]);
    expect(setCookie).toContain("__Host-ah_web=");
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/;", "Max-Age=28800", "Secure"])
      expect(setCookie).toContain(attribute);
    expect(setCookie).not.toContain("Domain");
    const raw = cookie.slice(cookie.indexOf("=") + 1);
    expect(result.body).not.toContain(raw);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(() => f.app.ctx.authService.verifyToken(raw)).toThrow();
    expect(f.app.ctx.authService.verifyToken(raw, BROWSER_AUDIENCE).projectId).toBe(f.project);
    expect(
      (await f.app.inject({ url: `/v1/projects/${f.project}`, headers: auth })).headers[
        "cache-control"
      ],
    ).toBe("no-store");
    expect(
      (await f.app.inject({ url: `/v1/projects/${f.project}`, headers: auth })).statusCode,
    ).toBe(200);
    expect((await f.app.inject({ url: `/v1/projects/${f.other}`, headers: auth })).statusCode).toBe(
      403,
    );
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/projects",
          headers: auth,
          payload: { name: "Unauthorized" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          url: "/v1/web/session",
          headers: { ...f.hostHeaders, authorization: `Bearer ${f.personal}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          url: `/v1/projects/${f.project}`,
          headers: { ...f.hostHeaders, authorization: `Bearer ${raw}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          url: "/v1/web/session",
          headers: { ...auth, authorization: "invalid" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          url: "/v1/web/session",
          headers: { ...f.hostHeaders, cookie: `ah_web=${raw}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          url: "/v1/web/session",
          headers: { ...auth, cookie: `${cookie}; ${cookie}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await f.app.inject({ url: "/v1/tokens", headers: auth })).statusCode).toBe(200);
    const unrelated = f.app.ctx.authService.createToken(f.user, "unrelated-audience");
    expect(
      f.app.ctx.authService.isTokenActive(
        f.app.ctx.authService.verifyToken(unrelated, "unrelated-audience").tokenId,
      ),
    ).toBe(false);
  });
  it("requires exact Origin/Host/Fetch-Site and allows HTTP only on loopback", async () => {
    const f = await fixture();
    const { auth, result } = await f.connect();
    expect(String(result.headers["set-cookie"])).toContain("Path=/v1/");
    expect(String(result.headers["set-cookie"])).not.toContain("Secure");
    const entry = f.entry();
    for (const invalid of [
      { host: headers.host },
      { ...headers, host: "evil.test" },
      { ...headers, origin: "https://evil.test" },
      { ...headers, "sec-fetch-site": "cross-site" },
      { ...headers, origin: "http://127.0.0.1:8796" },
    ]) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/v1/web/entry",
            headers: invalid,
            payload: { secret: entry.secret },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/v1/web/logout",
            headers: { ...invalid, cookie: auth.cookie },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/web/entry",
          headers,
          remoteAddress: "192.0.2.1",
          payload: { secret: entry.secret },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          url: "/v1/web/session",
          headers: { ...auth, origin: "https://evil.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/v1/projects/${f.project}/sessions`,
          headers: { host: headers.host, cookie: auth.cookie },
          payload: { agent_id: "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.exchange(entry.secret)).statusCode).toBe(200);
    expect(
      (await f.app.inject({ url: "/", headers: { ...auth, "sec-fetch-site": "cross-site" } }))
        .statusCode,
    ).toBe(404);
  });
  it("consumes once, checks expiry/revocation and rolls back session issuance and entry consumption on audit failure", async () => {
    const f = await fixture();
    const concurrent = f.entry();
    expect(
      (await Promise.all([f.exchange(concurrent.secret), f.exchange(concurrent.secret)]))
        .map((r) => r.statusCode)
        .sort(),
    ).toEqual([200, 401]);
    for (const column of ["expires_at", "revoked_at"] as const) {
      const entry = f.entry();
      f.app.ctx.db
        .prepare(`UPDATE web_entries SET ${column} = ? WHERE entry_id = ?`)
        .run(new Date(0).toISOString(), entry.entry_id);
      expect((await f.exchange(entry.secret)).statusCode).toBe(401);
    }
    const retry = f.entry();
    const tokensBefore = f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n;
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_web_audit BEFORE INSERT ON audit_entries WHEN NEW.action = 'web.session.start' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
    );
    expect((await f.exchange(retry.secret)).statusCode).toBe(500);
    expect(
      f.app.ctx.db
        .prepare("SELECT consumed_at FROM web_entries WHERE entry_id = ?")
        .get(retry.entry_id)?.consumed_at,
    ).toBeNull();
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n).toBe(tokensBefore);
    f.app.ctx.db.exec("DROP TRIGGER fail_web_audit");
    expect((await f.exchange(retry.secret)).statusCode).toBe(200);
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_entry_audit BEFORE INSERT ON audit_entries WHEN NEW.action = 'web.entry.issue' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
    );
    const count = f.app.ctx.db.prepare("SELECT COUNT(*) n FROM web_entries").get()?.n;
    expect(() => f.entry()).toThrow();
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) n FROM web_entries").get()?.n).toBe(count);
  });
  it("revalidates permissions, expires sessions, limits exchanges and logs out without revoking MCP credentials", async () => {
    const f = await fixture();
    const { auth } = await f.connect();
    const raw = auth.cookie.slice(7);
    const identity = f.app.ctx.authService.verifyToken(raw, BROWSER_AUDIENCE);
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_logout BEFORE INSERT ON audit_entries WHEN NEW.action = 'web.session.end' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
    );
    expect(
      (await f.app.inject({ method: "POST", url: "/v1/web/logout", headers: auth })).statusCode,
    ).toBe(500);
    expect(f.app.ctx.authService.isTokenActive(identity.tokenId)).toBe(true);
    f.app.ctx.db.exec("DROP TRIGGER fail_logout");
    f.app.ctx.db
      .prepare("UPDATE auth_tokens SET expires_at = ? WHERE token_id = ?")
      .run(new Date(0).toISOString(), identity.tokenId);
    expect((await f.app.inject({ url: "/v1/web/session", headers: auth })).statusCode).toBe(401);
    expect(
      (await f.app.inject({ method: "POST", url: "/v1/web/logout", headers: auth })).statusCode,
    ).toBe(200);
    const next = await f.connect();
    const logout = await f.app.inject({
      method: "POST",
      url: "/v1/web/logout",
      headers: next.auth,
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await f.app.inject({ url: "/v1/web/session", headers: next.auth })).statusCode).toBe(
      401,
    );
    expect(f.app.ctx.authService.verifyToken(f.personal).userId).toBe(f.user);
    const lostMembership = f.entry();
    f.app.ctx.db
      .prepare("DELETE FROM memberships WHERE project_id = ? AND user_id = ?")
      .run(f.project, f.user);
    expect((await f.exchange(lostMembership.secret)).statusCode).toBe(403);
    for (let n = 0; n < 30; n++) await f.exchange("invalid");
    const limited = await f.exchange("invalid");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
  it("uses real WebSocket tickets with browser session authority and closes the socket on logout", async () => {
    const f = await fixture();
    const { auth } = await f.connect();
    const joined = await f.app.inject({
      method: "POST",
      url: `/v1/projects/${f.project}/sessions`,
      headers: auth,
      payload: { agent_id: "human-dashboard", instance_id: crypto.randomUUID() },
    });
    expect(joined.statusCode).toBe(201);
    const sessionId = joined.json().data.session_id;
    f.app.ctx.db
      .prepare("UPDATE memberships SET role = 'reader' WHERE project_id = ? AND user_id = ?")
      .run(f.project, f.user);
    expect(
      (await f.app.inject({ url: "/v1/web/session", headers: auth })).json().data.project.role,
    ).toBe("reader");
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/v1/projects/${f.project}/messages`,
          headers: auth,
          payload: { session_id: sessionId, body: "Reader cannot write" },
        })
      ).statusCode,
    ).toBe(403);
    const ticket = await f.app.inject({
      method: "POST",
      url: `/v1/projects/${f.project}/ws-ticket`,
      headers: auth,
      payload: { session_id: sessionId },
    });
    expect(ticket.statusCode).toBe(201);
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new globalThis.WebSocket(
      `ws://127.0.0.1:${(f.app.server.address() as AddressInfo).port}/v1/projects/${f.project}/events?ticket=${ticket.json().data.ticket}&session_id=${sessionId}`,
      { headers: { Origin: origin } },
    );
    cleanups.push(async () => {
      socket.close();
    });
    const welcome = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS welcome timeout")), 3000);
      socket.onmessage = (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WS error"));
      };
    });
    expect(JSON.parse(welcome).type).toBe("connected");
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS close timeout")), 3000);
      socket.onclose = (event) => {
        clearTimeout(timer);
        resolve(event.code);
      };
    });
    expect(
      (await f.app.inject({ method: "POST", url: "/v1/web/logout", headers: auth })).statusCode,
    ).toBe(200);
    expect(await closed).toBe(1008);
    expect(f.app.ctx.authService.verifyToken(f.personal).userId).toBe(f.user);
  });
  it("upgrades schema 7 and preserves one-use entries plus browser authority through backup and reopen", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-web-access-"));
    const file = path.join(directory, "old.sqlite");
    const backup = path.join(directory, "snapshot.sqlite");
    let db: DatabaseSync | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      db = new DatabaseSync(file);
      // Historical setup is a fixture; the real upgrade below still runs production migrations.
      db.exec("BEGIN IMMEDIATE;");
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      for (const migration of MIGRATIONS.filter((m) => m.version <= 7)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      }
      db.exec("COMMIT;");
      db.close();
      db = undefined;
      db = createDatabase(file);
      app = buildApp({ CORS_ORIGINS: origin }, db);
      const user = crypto.randomUUID();
      const project = app.ctx.projectService.createProject("Restored web", user, "restored").project
        .project_id;
      const entry = app.ctx.webAccessService.issueEntry(user, { project_id: project }, "backup");
      const exchanged = app.ctx.webAccessService.exchange({ secret: entry.secret }, "first");
      const pending = app.ctx.webAccessService.issueEntry(user, { project_id: project }, "pending");
      await app.close();
      app = undefined;
      backupDatabase(db, backup);
      db.close();
      db = undefined;
      db = createDatabase(backup);
      app = buildApp({ CORS_ORIGINS: origin }, db);
      const who = app.ctx.authService.verifyToken(exchanged.secret, BROWSER_AUDIENCE);
      expect(app.ctx.webAccessService.profile(who).user.user_id).toBe(user);
      expect(() =>
        app?.ctx.webAccessService.exchange({ secret: entry.secret }, "replay"),
      ).toThrow();
      expect(
        app.ctx.webAccessService.exchange({ secret: pending.secret }, "after-restore").profile
          .project.project_id,
      ).toBe(project);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      await app?.close();
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
