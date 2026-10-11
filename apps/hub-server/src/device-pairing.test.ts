import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeviceCredentialSchema, containsObviousSecret } from "@agents-hub/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DeviceService } from "./application/services/device-service.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { MIGRATIONS } from "./infrastructure/db/migrations.js";
import {
  SqliteDeviceAuthority,
  SqliteDeviceRepository,
} from "./infrastructure/repositories/sqlite-device-repository.js";
import { redactSecrets } from "./infrastructure/security/redactor.js";

const origin = "http://127.0.0.1:8795";
const headers = { host: "127.0.0.1:8795", origin, "sec-fetch-site": "same-origin" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(db?: DatabaseSync) {
  const app = buildApp({ NODE_ENV: "production", CORS_ORIGINS: origin }, db);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    app.ctx.db.close();
  });
  const user = crypto.randomUUID();
  const project = app.ctx.projectService.createProject("Pairing", user, "alice").project.project_id;
  const otherUser = crypto.randomUUID();
  const otherProject = app.ctx.projectService.createProject("Other", otherUser, "other").project
    .project_id;
  const personal = app.ctx.authService.createToken(user, "agents-hub");
  const cookieFor = async (who = user, where = project) => {
    const entry = app.ctx.webAccessService.issueEntry(who, { project_id: where }, "fixture");
    const reply = await app.inject({
      method: "POST",
      url: "/v1/web/entry",
      headers,
      payload: { secret: entry.secret },
    });
    expect(reply.statusCode).toBe(200);
    return { ...headers, cookie: String(reply.headers["set-cookie"]).split(";")[0] as string };
  };
  const auth = await cookieFor();
  const request = () => app.ctx.deviceService.request({ label: "PC del amigo" });
  const preview = (id: string, h = auth) =>
    app.inject({
      method: "POST",
      url: "/v1/web/devices/preview",
      headers: h,
      payload: { request_id: id },
    });
  const approve = async (id: string, h = auth, body?: unknown) => {
    let payload = body;
    if (payload === undefined) {
      const reviewed = await preview(id, h);
      if (reviewed.statusCode !== 200) return reviewed;
      payload = { request_id: id, confirm: true, approval: reviewed.json().data.approval };
    }
    return app.inject({
      method: "POST",
      url: "/v1/web/devices/approve",
      headers: h,
      payload,
    });
  };
  const exchange = (secret: string) =>
    app.inject({ method: "POST", url: "/v1/devices/exchange", payload: { device_secret: secret } });
  return {
    app,
    user,
    project,
    otherUser,
    otherProject,
    personal,
    auth,
    cookieFor,
    request,
    approve,
    preview,
    exchange,
  };
}
describe("device pairing core", () => {
  it("revalidates a previously authenticated identity inside approval after revocation", async () => {
    const f = await fixture();
    const row = f.app.ctx.db
      .prepare(
        "SELECT token_id, expires_at FROM auth_tokens WHERE subject = ? AND audience = 'agents-hub-browser'",
      )
      .get(f.user) as { token_id: string; expires_at: string };
    const identity = {
      userId: f.user,
      projectId: f.project,
      tokenId: row.token_id,
      expiresAt: row.expires_at,
    };
    const request = f.request();
    const approval = f.app.ctx.deviceService.preview(identity, {
      request_id: request.request_id,
    }).approval;
    f.app.ctx.authService.revokeToken(row.token_id, f.user);
    expect(() =>
      f.app.ctx.deviceService.approve(
        identity,
        { request_id: request.request_id, confirm: true, approval },
        "cached-request",
      ),
    ).toThrow("Vinculación");
    expect(() =>
      f.app.ctx.deviceService.preview(identity, { request_id: request.request_id }),
    ).toThrow("Vinculación");
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
  });
  it("rejects a revoked human session before using its otherwise valid review", async () => {
    const f = await fixture();
    const request = f.request();
    const approval = (await f.preview(request.request_id)).json().data.approval;
    const tokenId = f.app.ctx.db
      .prepare(
        "SELECT token_id FROM auth_tokens WHERE subject = ? AND audience = 'agents-hub-browser'",
      )
      .get(f.user)?.token_id as string;
    f.app.ctx.authService.revokeToken(tokenId, f.user);
    expect(
      (
        await f.approve(request.request_id, f.auth, {
          request_id: request.request_id,
          confirm: true,
          approval,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
    expect((await f.exchange(request.device_secret)).statusCode).toBe(401);
  });
  it("requires a reviewed context and rejects a different human cookie even for the same person/project", async () => {
    const f = await fixture();
    const request = f.request();
    const reviewed = (await f.preview(request.request_id)).json().data;
    const body = { request_id: request.request_id, confirm: true, approval: reviewed.approval };
    expect(
      (
        await f.approve(request.request_id, f.auth, {
          request_id: request.request_id,
          confirm: true,
        })
      ).statusCode,
    ).toBe(422);
    for (const auth of [await f.cookieFor(), await f.cookieFor(f.otherUser, f.otherProject)]) {
      const denied = await f.approve(request.request_id, auth, body);
      expect(denied.statusCode).toBe(409);
      expect(denied.body).not.toContain(reviewed.approval.proof);
    }
    const project = f.app.ctx.projectService.createProject("Same person other project", f.user)
      .project.project_id;
    expect(
      (await f.approve(request.request_id, await f.cookieFor(f.user, project), body)).statusCode,
    ).toBe(409);
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
    expect((await f.approve(request.request_id, f.auth, body)).statusCode).toBe(200);
    expect((await f.approve(request.request_id, f.auth, body)).statusCode).toBe(401);
  });
  it("rejects changed role, project name and device label, and allows a new review of current context", async () => {
    const f = await fixture();
    const changes = [
      () =>
        f.app.ctx.db
          .prepare("UPDATE memberships SET role = 'reader' WHERE user_id = ? AND project_id = ?")
          .run(f.user, f.project),
      () =>
        f.app.ctx.db
          .prepare("UPDATE projects SET name = 'Renamed' WHERE project_id = ?")
          .run(f.project),
      (id: string) =>
        f.app.ctx.db
          .prepare("UPDATE device_requests SET label = 'Changed' WHERE request_id = ?")
          .run(id),
    ];
    for (const change of changes) {
      const request = f.request();
      const reviewed = (await f.preview(request.request_id)).json().data;
      change(request.request_id);
      expect(
        (
          await f.approve(request.request_id, f.auth, {
            request_id: request.request_id,
            confirm: true,
            approval: reviewed.approval,
          })
        ).statusCode,
      ).toBe(409);
      expect((await f.approve(request.request_id)).statusCode).toBe(200);
    }
  });
  it("rejects tampering, cross-request use and unknown approval fields without consuming the request", async () => {
    const f = await fixture();
    const request = f.request();
    const other = f.request();
    const reviewed = (await f.preview(request.request_id)).json().data;
    const approval = reviewed.approval;
    const proof = approval.proof.slice(0, -1) + (approval.proof.endsWith("A") ? "B" : "A");
    for (const input of [
      { ...approval, proof },
      { ...approval, expires_at: new Date(Date.parse(approval.expires_at) + 1000).toISOString() },
    ]) {
      expect(
        (
          await f.approve(request.request_id, f.auth, {
            request_id: request.request_id,
            confirm: true,
            approval: input,
          })
        ).statusCode,
      ).toBe(409);
    }
    expect(
      (
        await f.approve(other.request_id, f.auth, {
          request_id: other.request_id,
          confirm: true,
          approval,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.approve(request.request_id, f.auth, {
          request_id: request.request_id,
          confirm: true,
          approval: { ...approval, user_id: f.otherUser },
        })
      ).statusCode,
    ).toBe(422);
    expect(containsObviousSecret(approval.proof)).toBe(true);
    expect(String(redactSecrets(`review ${approval.proof}`))).not.toContain(approval.proof);
    expect(redactSecrets({ approval: { proof: "unrecognized-proof-format" } })).toEqual({
      approval: { proof: "***REDACTED***" },
    });
    expect(() => f.app.ctx.deviceService.request({ label: approval.proof })).toThrow();
    expect(
      JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM device_requests").all()),
    ).not.toContain(approval.proof);
    expect(
      (
        await f.approve(request.request_id, f.auth, {
          request_id: request.request_id,
          confirm: true,
          approval,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("caps review TTL by request and human expiry, rejects expired review and rotates key on restart", async () => {
    const f = await fixture();
    let now = Date.now();
    const make = () =>
      new DeviceService(
        new SqliteDeviceRepository(f.app.ctx.db),
        f.app.ctx.eventBus,
        new SqliteDeviceAuthority(f.app.ctx.db),
        f.app.ctx.webAccessService,
        f.app.ctx.auditService,
        () => now,
      );
    const service = make();
    const session = f.app.ctx.db
      .prepare(
        "SELECT token_id, expires_at FROM auth_tokens WHERE subject = ? AND audience = 'agents-hub-browser'",
      )
      .get(f.user) as { token_id: string; expires_at: string };
    const identity = {
      userId: f.user,
      projectId: f.project,
      tokenId: session.token_id,
      expiresAt: session.expires_at,
    };
    const request = service.request({ label: "Clock" });
    const reviewed = service.preview(identity, { request_id: request.request_id });
    expect(Date.parse(reviewed.approval.expires_at) - now).toBe(120000);
    const input = { request_id: request.request_id, confirm: true, approval: reviewed.approval };
    expect(() => make().approve(identity, input, "restart")).toThrow("Revisa");
    now += 120000;
    expect(() => service.approve(identity, input, "expired")).toThrow("Revisa");
    const short = { ...identity, expiresAt: new Date(now + 1000).toISOString() };
    f.app.ctx.db
      .prepare("UPDATE auth_tokens SET expires_at = ? WHERE token_id = ?")
      .run(short.expiresAt, short.tokenId);
    expect(service.preview(short, { request_id: request.request_id }).approval.expires_at).toBe(
      short.expiresAt,
    );
    f.app.ctx.db
      .prepare("UPDATE device_requests SET expires_at = ? WHERE request_id = ?")
      .run(new Date(now + 500).toISOString(), request.request_id);
    expect(service.preview(short, { request_id: request.request_id }).approval.expires_at).toBe(
      new Date(now + 500).toISOString(),
    );
    now += 500;
    expect(() => service.preview(short, { request_id: request.request_id })).toThrow();
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
  });
  it("allows only one approval in a race and retries the same proof after audit rollback", async () => {
    const f = await fixture();
    const request = f.request();
    const approval = (await f.preview(request.request_id)).json().data.approval;
    const body = { request_id: request.request_id, confirm: true, approval };
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_review BEFORE INSERT ON audit_entries WHEN NEW.action = 'device.approve' BEGIN SELECT RAISE(ABORT, 'test'); END;",
    );
    expect((await f.approve(request.request_id, f.auth, body)).statusCode).toBe(500);
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
    f.app.ctx.db.exec("DROP TRIGGER fail_review");
    const results = await Promise.all([
      f.approve(request.request_id, f.auth, body),
      f.approve(request.request_id, f.auth, body),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(
      f.app.ctx.db
        .prepare("SELECT COUNT(*) n FROM audit_entries WHERE action = 'device.approve'")
        .get()?.n,
    ).toBe(1);
  });
  it("requires human approval, keeps preview read-only, and issues one project-scoped MCP credential", async () => {
    const f = await fixture();
    const created = await f.app.inject({
      method: "POST",
      url: "/v1/devices/requests",
      payload: { label: "Mi Linux" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers["cache-control"]).toBe("no-store");
    const request = created.json().data;
    expect((await f.exchange(request.device_secret)).statusCode).toBe(401);
    const before = f.app.ctx.db.prepare("SELECT * FROM device_requests").all();
    const preview = await f.app.inject({
      method: "POST",
      url: "/v1/web/devices/preview",
      headers: f.auth,
      payload: { request_id: request.request_id },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.profile.user.user_id).toBe(f.user);
    expect(preview.json().data.profile.project.project_id).toBe(f.project);
    expect(preview.json().data.label).toBe("Mi Linux");
    expect(f.app.ctx.db.prepare("SELECT * FROM device_requests").all()).toEqual(before);
    expect((await f.approve(request.request_id)).statusCode).toBe(200);
    expect((await f.approve(request.request_id)).statusCode).toBe(401);
    const replies = await Promise.all([
      f.exchange(request.device_secret),
      f.exchange(request.device_secret),
    ]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const credential = DeviceCredentialSchema.parse(
      replies.find((r) => r.statusCode === 200)?.json().data,
    );
    const identity = f.app.ctx.authService.verifyToken(credential.token);
    expect(identity.userId).toBe(f.user);
    expect(identity.projectId).toBe(f.project);
    expect(identity.scopes).not.toContain("*");
    expect(identity.scopes).not.toContain("projects:write");
    expect(identity.scopes).not.toContain("members:write");
    expect(Date.parse(credential.expires_at) - Date.now()).toBeGreaterThan(2591900000);
    const joined = await f.app.inject({
      method: "POST",
      url: `/v1/projects/${f.project}/sessions`,
      headers: { authorization: `Bearer ${credential.token}` },
      payload: { agent_id: "paired" },
    });
    expect(joined.statusCode).toBe(201);
    const unrelated = await f.app.inject({
      method: "GET",
      url: `/v1/projects/${f.otherProject}`,
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect(unrelated.statusCode).toBe(403);
    const list = await f.app.inject({ url: "/v1/web/devices", headers: f.auth });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].token_id).toBe(credential.token_id);
    const persisted =
      JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM device_requests").all()) +
      JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM auth_tokens").all()) +
      JSON.stringify(f.app.ctx.db.prepare("SELECT * FROM audit_entries").all()) +
      list.body;
    expect(persisted).not.toContain(request.device_secret);
    expect(persisted).not.toContain(credential.token);
    expect(list.body).not.toContain("secret_hash");
  });
  it("rejects bearer approval, missing confirmation, forged fields and foreign Origin", async () => {
    const f = await fixture();
    const request = f.request();
    const post = (h: Record<string, string>, payload: unknown) =>
      f.app.inject({ method: "POST", url: "/v1/web/devices/approve", headers: h, payload });
    expect(
      (
        await post(
          { ...headers, authorization: `Bearer ${f.personal}` },
          { request_id: request.request_id, confirm: true },
        )
      ).statusCode,
    ).toBe(401);
    expect((await post(f.auth, { request_id: request.request_id })).statusCode).toBe(422);
    expect(
      (await post(f.auth, { request_id: request.request_id, confirm: true, user_id: f.otherUser }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await post(f.auth, {
          request_id: request.request_id,
          confirm: true,
          project_id: f.otherProject,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await post(
          { ...f.auth, origin: "https://evil.example" },
          { request_id: request.request_id, confirm: true },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(headers, { request_id: request.request_id, confirm: true })).statusCode,
    ).toBe(401);
    expect((await f.exchange(request.device_secret)).statusCode).toBe(401);
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
  });
  it("enforces TTL at both transitions and rechecks membership before canje", async () => {
    const f = await fixture();
    const expired = f.request();
    f.app.ctx.db
      .prepare("UPDATE device_requests SET expires_at = ? WHERE request_id = ?")
      .run(new Date(0).toISOString(), expired.request_id);
    expect((await f.approve(expired.request_id)).statusCode).toBe(401);
    const request = f.request();
    expect((await f.approve(request.request_id)).statusCode).toBe(200);
    const before = f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n;
    f.app.ctx.db
      .prepare("DELETE FROM memberships WHERE user_id = ? AND project_id = ?")
      .run(f.user, f.project);
    expect((await f.exchange(request.device_secret)).statusCode).toBe(401);
    expect(
      f.app.ctx.db
        .prepare("SELECT consumed_at FROM device_requests WHERE request_id = ?")
        .get(request.request_id)?.consumed_at,
    ).toBeNull();
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n).toBe(before);
    const g = await fixture();
    const approved = g.request();
    await g.approve(approved.request_id);
    g.app.ctx.db
      .prepare("UPDATE device_requests SET expires_at = ?")
      .run(new Date(0).toISOString());
    expect((await g.exchange(approved.device_secret)).statusCode).toBe(401);
    expect((await g.exchange("invalid")).body).not.toContain("invalid");
  });
  it("rolls back approval and issuance on audit failure, then retries without a duplicate token", async () => {
    const f = await fixture();
    const request = f.request();
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_device BEFORE INSERT ON audit_entries WHEN NEW.action LIKE 'device.%' BEGIN SELECT RAISE(ABORT, 'test'); END;",
    );
    expect((await f.approve(request.request_id)).statusCode).toBe(500);
    expect(
      f.app.ctx.db.prepare("SELECT approved_at FROM device_requests").get()?.approved_at,
    ).toBeNull();
    f.app.ctx.db.exec("DROP TRIGGER fail_device");
    await f.approve(request.request_id);
    const before = f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n;
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_issue BEFORE INSERT ON audit_entries WHEN NEW.action = 'device.issue' BEGIN SELECT RAISE(ABORT, 'test'); END;",
    );
    expect((await f.exchange(request.device_secret)).statusCode).toBe(500);
    expect(f.app.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n).toBe(before);
    expect(
      f.app.ctx.db.prepare("SELECT consumed_at, token_id FROM device_requests").get(),
    ).toMatchObject({ consumed_at: null, token_id: null });
    f.app.ctx.db.exec("DROP TRIGGER fail_issue");
    expect((await f.exchange(request.device_secret)).statusCode).toBe(200);
    expect((await f.exchange(request.device_secret)).statusCode).toBe(401);
    expect(
      f.app.ctx.db
        .prepare("SELECT COUNT(*) n FROM audit_entries WHERE action = 'device.issue'")
        .get()?.n,
    ).toBe(1);
  });
  it("lists and revokes only own device credentials in the human session project", async () => {
    const f = await fixture();
    const request = f.request();
    await f.approve(request.request_id);
    const credential = (await f.exchange(request.device_secret)).json().data;
    const other = await f.cookieFor(f.otherUser, f.otherProject);
    expect((await f.app.inject({ url: "/v1/web/devices", headers: other })).json().data).toEqual(
      [],
    );
    const revoke = (token: string, h = f.auth, payload: unknown = { confirm: true }) =>
      f.app.inject({ method: "POST", url: `/v1/web/devices/${token}/revoke`, headers: h, payload });
    expect((await revoke(credential.token_id, other)).statusCode).toBe(401);
    expect((await revoke(credential.token_id, f.auth, { confirm: false })).statusCode).toBe(422);
    const personalId = f.app.ctx.authService.verifyToken(f.personal).tokenId;
    expect((await revoke(personalId)).statusCode).toBe(401);
    expect((await revoke(credential.token_id)).statusCode).toBe(200);
    expect((await revoke(credential.token_id)).statusCode).toBe(200);
    expect(() => f.app.ctx.authService.verifyToken(credential.token)).toThrow();
    expect(f.app.ctx.authService.verifyToken(f.personal).userId).toBe(f.user);
    expect((await f.app.inject({ url: "/v1/web/session", headers: f.auth })).statusCode).toBe(200);
    expect(
      (await f.app.inject({ url: "/v1/web/devices", headers: f.auth })).json().data[0].revoked_at,
    ).not.toBeNull();
  });
  it("rejects credential labels, redacts the new secret prefix and bounds unauthenticated requests", async () => {
    const f = await fixture();
    const request = f.request();
    expect(containsObviousSecret(request.device_secret)).toBe(true);
    expect(String(redactSecrets(`failed ${request.device_secret}`))).not.toContain(
      request.device_secret,
    );
    for (const label of [request.device_secret, "ahb_abcdefghijk", "a\nb", "", "x".repeat(81)]) {
      expect(() => f.app.ctx.deviceService.request({ label })).toThrow();
    }
    for (let i = 0; i < 10; i++)
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/v1/devices/requests",
            payload: { label: "test" },
          })
        ).statusCode,
      ).toBe(200);
    expect((await f.exchange(request.device_secret)).statusCode).toBe(429);
  });
  it("fences role changes and rolls back revocation when audit fails", async () => {
    const f = await fixture();
    const request = f.request();
    await f.approve(request.request_id);
    f.app.ctx.db
      .prepare("UPDATE memberships SET role = 'reader' WHERE user_id = ? AND project_id = ?")
      .run(f.user, f.project);
    const credential = (await f.exchange(request.device_secret)).json().data;
    const bearer = { authorization: `Bearer ${credential.token}` };
    const joined = await f.app.inject({
      method: "POST",
      url: `/v1/projects/${f.project}/sessions`,
      headers: bearer,
      payload: { agent_id: "reader-device" },
    });
    expect(joined.statusCode).toBe(201);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/v1/projects/${f.project}/messages`,
          headers: bearer,
          payload: { session_id: joined.json().data.session_id, body: "Not allowed" },
        })
      ).statusCode,
    ).toBe(403);
    f.app.ctx.db.exec(
      "CREATE TRIGGER fail_revoke BEFORE INSERT ON audit_entries WHEN NEW.action = 'device.revoke' BEGIN SELECT RAISE(ABORT, 'test'); END;",
    );
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/v1/web/devices/${credential.token_id}/revoke`,
          headers: f.auth,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(500);
    expect(f.app.ctx.authService.verifyToken(credential.token).userId).toBe(f.user);
    f.app.ctx.db.exec("DROP TRIGGER fail_revoke");
    f.app.ctx.db
      .prepare("UPDATE auth_tokens SET expires_at = ? WHERE token_id = ?")
      .run(new Date(0).toISOString(), credential.token_id);
    expect(() => f.app.ctx.authService.verifyToken(credential.token)).toThrow();
  });
  it("upgrades schema10 and preserves issued credential metadata and revocation after backup/reopen", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ah-device-upgrade-"));
    const file = path.join(directory, "source.db");
    const target = path.join(directory, "backup.db");
    const old = new DatabaseSync(file);
    old.exec(
      "BEGIN; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    for (const migration of MIGRATIONS.filter((m) => m.version <= 10)) {
      old.exec(migration.sql);
      old
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
    old.exec("COMMIT;");
    old.close();
    try {
      const f = await fixture(createDatabase(file));
      const request = f.request();
      await f.approve(request.request_id);
      const credential = (await f.exchange(request.device_secret)).json().data;
      backupDatabase(f.app.ctx.db, target);
      const restored = buildApp(
        { NODE_ENV: "production", CORS_ORIGINS: origin },
        createDatabase(target),
      );
      try {
        expect(
          restored.ctx.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
        ).toBe(11);
        expect(restored.ctx.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        expect(restored.ctx.authService.verifyToken(credential.token).userId).toBe(f.user);
        const identity = {
          userId: f.user,
          projectId: f.project,
          tokenId: "test",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        };
        expect(restored.ctx.deviceService.list(identity)[0]?.token_id).toBe(credential.token_id);
        restored.ctx.deviceService.revoke(identity, credential.token_id, "test");
        expect(() => restored.ctx.authService.verifyToken(credential.token)).toThrow();
      } finally {
        await restored.close();
        restored.ctx.db.close();
      }
    } finally {
      await cleanups.pop()?.();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
