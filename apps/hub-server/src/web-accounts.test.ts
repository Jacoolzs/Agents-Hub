import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BROWSER_AUDIENCE } from "@agents-hub/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { WebAccountService } from "./application/services/web-account-service.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";
import { SqliteWebSessionAuthority } from "./infrastructure/repositories/sqlite-web-access-repository.js";
import { SqliteWebAccountRepository } from "./infrastructure/repositories/sqlite-web-account-repository.js";
import {
  derivePassword,
  equalPassword,
  passwordSalt,
} from "./infrastructure/security/passwords.js";
import { buildLocalControl } from "./local/control-app.js";

const origin = "http://127.0.0.1:8795";
const headers = { host: "127.0.0.1:8795", origin, "sec-fetch-site": "same-origin" };
const password = "Una frase larga y segura 👋";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function fixture(db?: DatabaseSync) {
  const app = buildApp({ NODE_ENV: "production", CORS_ORIGINS: origin }, db);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    app.ctx.db.close();
  });
  const user = crypto.randomUUID();
  const project = app.ctx.projectService.createProject("Account project", user, "account-user")
    .project.project_id;
  const personal = app.ctx.authService.createToken(user, "agents-hub");
  const username = String(
    app.ctx.db.prepare("SELECT username FROM users WHERE user_id = ?").get(user)?.username,
  );
  const entry = app.ctx.webAccessService.issueEntry(user, { project_id: project }, "issue");
  const result = await app.inject({
    method: "POST",
    url: "/v1/web/entry",
    headers,
    payload: { secret: entry.secret },
  });
  const cookie = String(result.headers["set-cookie"]).split(";")[0] as string;
  const auth = { ...headers, cookie };
  const enroll = (value = password) =>
    app.inject({
      method: "POST",
      url: "/v1/web/account",
      headers: auth,
      payload: { password: value },
    });
  const login = (value = password, loginName = username, projectId?: string) =>
    app.inject({
      method: "POST",
      url: "/v1/web/login",
      headers,
      payload: {
        username: loginName,
        password: value,
        ...(projectId ? { project_id: projectId } : {}),
      },
    });
  return { app, user, username, project, personal, cookie, auth, enroll, login };
}
describe("local human accounts", () => {
  it("requires browser identity, origin and a strong bounded password; returns generic login errors and no secrets", async () => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/web/account",
          headers: { ...headers, authorization: `Bearer ${f.personal}` },
          payload: { password },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/web/account",
          headers: { ...f.auth, origin: "https://evil.example" },
          payload: { password },
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.enroll("short")).statusCode).toBe(422);
    expect((await f.enroll("👋".repeat(8))).statusCode).toBe(422);
    expect((await f.enroll("x".repeat(129))).statusCode).toBe(422);
    expect((await f.enroll()).statusCode).toBe(200);
    const stored = f.app.ctx.db.prepare("SELECT * FROM web_accounts").get();
    expect(stored?.salt).toMatch(/^[a-f0-9]{32}$/);
    expect(stored?.password_hash).toMatch(/^[a-f0-9]{128}$/);
    expect(JSON.stringify(stored)).not.toContain(password);
    expect((await f.enroll()).statusCode).toBe(409);
    const wrong = await f.login("Wrong password phrase");
    const absent = await f.login("Wrong password phrase", "missing-user");
    expect(wrong.statusCode).toBe(401);
    expect(absent.statusCode).toBe(401);
    expect(absent.json().error.message).toBe(wrong.json().error.message);
    const logged = await f.login();
    expect(logged.statusCode).toBe(200);
    expect(logged.json().data.project.project_id).toBe(f.project);
    expect(JSON.stringify(logged.json())).not.toMatch(/password|salt|ah_/);
    expect(logged.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict");
    const raw = String(logged.headers["set-cookie"]).split(";")[0]?.split("=")[1] as string;
    expect(() => f.app.ctx.authService.verifyToken(raw)).toThrow();
    expect(f.app.ctx.authService.verifyToken(raw, BROWSER_AUDIENCE).userId).toBe(f.user);
    expect(JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM audit_entries").all())).not.toContain(
      password,
    );
  }, 15000);

  it("reveals project choices only after verification, rejects foreign projects and throttles per account", async () => {
    const f = await fixture();
    await f.enroll();
    const second = f.app.ctx.projectService.createProject("Second", f.user).project.project_id;
    const choices = await f.login();
    expect(choices.statusCode).toBe(200);
    expect(choices.headers["set-cookie"]).toBeUndefined();
    expect(
      choices
        .json()
        .data.projects.map((p: { project_id: string }) => p.project_id)
        .sort(),
    ).toEqual([f.project, second].sort());
    expect((await f.login(password, f.username, crypto.randomUUID())).statusCode).toBe(401);
    expect((await f.login(password, f.username, second)).json().data.project.project_id).toBe(
      second,
    );
    await f.login("Wrong password phrase");
    await f.login("Wrong password phrase");
    const throttled = await f.login();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
  }, 15000);

  it("recovers only through private local authority, invalidates human sessions/entries but preserves MCP and membership", async () => {
    const f = await fixture();
    await f.enroll();
    const pending = f.app.ctx.webAccessService.issueEntry(
      f.user,
      { project_id: f.project },
      "pending",
    );
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
    cleanups.push(async () => control.app.close());
    const route = `/local-api/users/${f.user}/reset-web-account`;
    const localHeaders = { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791" };
    expect(
      (await f.app.inject({ method: "POST", url: route, headers: f.auth, payload: {} })).statusCode,
    ).toBe(404);
    expect(
      (await control.app.inject({ method: "POST", url: route, headers: localHeaders, payload: {} }))
        .statusCode,
    ).toBe(401);
    const secret = new URLSearchParams(new URL(control.bootstrapUrl).hash.slice(1)).get(
      "local-control",
    );
    const boot = await control.app.inject({
      method: "POST",
      url: "/local-api/bootstrap",
      headers: localHeaders,
      payload: { secret },
    });
    const localAuth = {
      ...localHeaders,
      cookie: String(boot.headers["set-cookie"]).split(";")[0] as string,
    };
    expect(
      (
        await control.app.inject({
          method: "POST",
          url: route,
          headers: { ...localAuth, origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await control.app.inject({ method: "POST", url: route, headers: localAuth, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ method: "GET", url: "/v1/web/session", headers: f.auth })).statusCode,
    ).toBe(401);
    expect((await f.login()).statusCode).toBe(401);
    expect(() => f.app.ctx.webAccessService.preview({ secret: pending.secret })).toThrow();
    expect(f.app.ctx.authService.verifyToken(f.personal).userId).toBe(f.user);
    expect(f.app.ctx.authService.checkProjectPermission(f.user, f.project)).toBe("owner");
    const entry = f.app.ctx.webAccessService.issueEntry(
      f.user,
      { project_id: f.project },
      "recover",
    );
    const recovered = f.app.ctx.webAccessService.exchange({ secret: entry.secret }, "recover");
    await f.app.ctx.webAccountService.enroll(
      f.app.ctx.authService.verifyToken(recovered.secret, BROWSER_AUDIENCE),
      { password: "La nueva frase de mi cuenta" },
      "enroll",
    );
    expect((await f.login("La nueva frase de mi cuenta")).statusCode).toBe(200);
  }, 15000);

  it("rolls back enrollment/login/reset when audit fails", async () => {
    const f = await fixture();
    const fail = () =>
      f.app.ctx.db.exec(
        "CREATE TRIGGER fail_account_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
      );
    const clear = () => f.app.ctx.db.exec("DROP TRIGGER fail_account_audit;");
    fail();
    expect((await f.enroll()).statusCode).toBe(500);
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) AS n FROM web_accounts").get()?.n).toBe(0);
    clear();
    await f.enroll();
    const before = f.app.ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_tokens").get()?.n;
    fail();
    expect((await f.login()).statusCode).toBe(500);
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_tokens").get()?.n).toBe(before);
    expect(() => f.app.ctx.webAccountService.reset(f.user, "reset")).toThrow();
    expect(f.app.ctx.webAccountService.registered(f.user)).toBe(true);
    expect(
      (await f.app.inject({ method: "GET", url: "/v1/web/session", headers: f.auth })).statusCode,
    ).toBe(200);
    clear();
  }, 15000);

  it("fences reset while an asynchronous password derivation is in flight", async () => {
    const f = await fixture();
    let finish: (hash: string) => void = () => {};
    const service = new WebAccountService(
      new SqliteWebAccountRepository(f.app.ctx.db),
      f.app.ctx.eventBus,
      new SqliteWebSessionAuthority(f.app.ctx.db),
      f.app.ctx.webAccessService,
      f.app.ctx.auditService,
      {
        salt: () => "test",
        derive: async () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        equal: (a, b) => a === b,
      },
    );
    const identity = f.app.ctx.authService.verifyToken(
      f.cookie.split("=")[1] as string,
      BROWSER_AUDIENCE,
    );
    const pending = service.enroll(identity, { password }, "enroll");
    service.reset(f.user, "reset");
    finish("test-hash");
    await expect(pending).rejects.toThrow();
    expect(service.registered(f.user)).toBe(false);
    // Repeat for verified login: deletion during hashing must prevent a new session.
    f.app.ctx.db
      .prepare("INSERT INTO web_accounts VALUES (?, 'test', 'test-hash', ?)")
      .run(f.user, new Date().toISOString());
    const login = service.login({ username: f.username, password }, "login");
    service.reset(f.user, "reset");
    finish("test-hash");
    await expect(login).rejects.toThrow();
  });

  it("upgrades schema9 and preserves real password login across backup and reopen", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-accounts-"));
    const file = path.join(directory, "source.db");
    const target = path.join(directory, "backup.db");
    const old = new DatabaseSync(file);
    old.exec(
      "BEGIN; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    for (const m of MIGRATIONS.filter((m) => m.version <= 9)) {
      old.exec(m.sql);
      old
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(m.version, new Date().toISOString());
    }
    old.exec("COMMIT;");
    old.close();
    const f = await fixture(createDatabase(file));
    await f.enroll();
    backupDatabase(f.app.ctx.db, target);
    const restored = buildApp(
      { NODE_ENV: "production", CORS_ORIGINS: origin },
      createDatabase(target),
    );
    try {
      const login = await restored.inject({
        method: "POST",
        url: "/v1/web/login",
        headers,
        payload: { username: f.username, password },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().data.project.project_id).toBe(f.project);
      expect(restored.ctx.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      await restored.close();
      restored.ctx.db.close();
      // Close the owned fixture before removing its temporary database.
      await cleanups.pop()?.();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

  it("uses unique salts, exact Unicode passwords and bounds concurrent expensive work", async () => {
    const salt = passwordSalt();
    expect(salt).not.toBe(passwordSalt());
    const first = derivePassword(password, salt);
    await expect(derivePassword(password, salt)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const hash = await first;
    expect(equalPassword(await derivePassword(password, salt), hash)).toBe(true);
    expect(equalPassword(await derivePassword(`${password} `, salt), hash)).toBe(false);
  }, 15000);
});
