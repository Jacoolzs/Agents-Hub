import { createServer } from "node:net";
import { loadConfig } from "@agents-hub/config";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../infrastructure/db/database.js";
import type { ConnectionAssistant } from "./connection-assistant.js";
import { type LocalInstallation, type LocalRuntime, buildLocalControl } from "./control-app.js";
import { CompanionRuntime } from "./runtime.js";

const origin = "http://127.0.0.1:8791";
const headers = { host: "127.0.0.1:8791", origin };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  clock?: () => number,
  closeCompanion?: () => void,
  installation?: LocalInstallation,
  connections?: Pick<
    ConnectionAssistant,
    "start" | "finish" | "list" | "diagnose" | "importPreview" | "importApply"
  >,
) {
  const hub = buildApp();
  await hub.ready();
  const runtime: LocalRuntime = {
    context: () => hub.ctx,
    status: () => ({ hub: "stopped", sharing: "stopped", portal_url: null }),
    start: async () => {},
    stop: async () => {},
    share: async () => {},
    stopSharing: async () => {},
  };
  const control = buildLocalControl(
    runtime,
    origin,
    undefined,
    clock,
    closeCompanion,
    installation,
    connections,
  );
  cleanups.push(async () => {
    await control.app.close();
    await hub.close();
    hub.ctx.db.close();
  });
  const secret = new URLSearchParams(new URL(control.bootstrapUrl).hash.slice(1)).get(
    "local-control",
  );
  const connect = async () => {
    const reply = await control.app.inject({
      method: "POST",
      url: "/local-api/bootstrap",
      headers,
      payload: { secret },
    });
    expect(reply.statusCode).toBe(200);
    const cookie = String(reply.headers["set-cookie"]).split(";")[0] as string;
    return { ...headers, cookie };
  };
  return { hub, runtime, control, secret, connect };
}

describe("local administrative boundary", () => {
  it("keeps passive connection checks private and serialized with runtime/shutdown", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const connections = {
      start: async () => {
        throw new Error("Not used");
      },
      finish: async () => {
        throw new Error("Not used");
      },
      list: async () => [],
      importPreview: async () => {
        throw new Error("Not used");
      },
      importApply: async () => {
        throw new Error("Not used");
      },
      diagnose: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
          entered?.();
        });
        return { ok: true, checks: [] };
      },
    };
    const f = await fixture(undefined, () => {}, undefined, connections);
    const url = "/local-api/connections/diagnose";
    const payload = { connection_id: crypto.randomUUID() };
    expect((await f.hub.inject({ method: "POST", url, payload })).statusCode).toBe(404);
    expect((await f.control.app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(
      401,
    );
    const authenticated = await f.connect();
    for (const endpoint of [
      "/local-api/connections/import/preview",
      "/local-api/connections/import/apply",
    ]) {
      expect((await f.hub.inject({ method: "POST", url: endpoint, payload })).statusCode).toBe(404);
      expect(
        (await f.control.app.inject({ method: "POST", url: endpoint, headers, payload }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url: endpoint,
            headers: { ...authenticated, origin: "https://foreign.example" },
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }
    for (const altered of [
      { ...authenticated, origin: "https://foreign.example" },
      { ...authenticated, host: "foreign.example" },
    ])
      expect(
        (await f.control.app.inject({ method: "POST", url, headers: altered, payload })).statusCode,
      ).toBe(403);
    const pending = f.control.app
      .inject({ method: "POST", url, headers: authenticated, payload })
      .then((result) => result);
    await started;
    try {
      for (const other of [url, "/local-api/runtime/stop", "/local-api/companion/shutdown"])
        expect(
          (
            await f.control.app.inject({
              method: "POST",
              url: other,
              headers: authenticated,
              payload: { confirm: true },
            })
          ).statusCode,
        ).toBe(409);
    } finally {
      release?.();
    }
    expect((await pending).json()).toEqual({ ok: true, checks: [] });
  });
  it("requires private explicit installation and keeps runtime and shutdown serialized", async () => {
    let finish: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const result = {
      installed: true,
      destination: "resources",
      data: "data",
      label: "Agents-Hub",
      shortcuts: ["menu"],
    };
    const installer = {
      describe: async () => ({ state: "ready", destination: "resources", data: "data" }),
      install: async (_desktop: boolean) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
          entered?.();
        });
        return result;
      },
    };
    const f = await fixture(undefined, () => {}, installer);
    const url = "/local-api/installation";
    expect(
      (await f.hub.inject({ method: "POST", url, payload: { confirm: true } })).statusCode,
    ).toBe(404);
    expect((await f.control.app.inject({ method: "GET", url, headers })).statusCode).toBe(401);
    const authenticated = await f.connect();
    for (const altered of [
      { ...authenticated, origin: "https://example.com" },
      { ...authenticated, host: "example.com" },
    ])
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url,
            headers: altered,
            payload: { confirm: true },
          })
        ).statusCode,
      ).toBe(403);
    for (const payload of [
      {},
      { confirm: false },
      { confirm: true, path: "foreign" },
      { confirm: true, desktop: "yes" },
    ])
      expect(
        (await f.control.app.inject({ method: "POST", url, headers: authenticated, payload }))
          .statusCode,
      ).toBe(422);
    expect(
      (await f.control.app.inject({ method: "GET", url, headers: authenticated })).json(),
    ).toEqual(await installer.describe());
    const pending = f.control.app
      .inject({
        method: "POST",
        url,
        headers: authenticated,
        payload: { confirm: true, desktop: true },
      })
      .then((reply) => reply);
    await started;
    try {
      for (const blocked of [url, "/local-api/runtime/start", "/local-api/companion/shutdown"])
        expect(
          (
            await f.control.app.inject({
              method: "POST",
              url: blocked,
              headers: authenticated,
              payload: { confirm: true },
            })
          ).statusCode,
        ).toBe(409);
    } finally {
      finish?.();
    }
    expect((await pending).json()).toEqual(result);
    installer.install = async () => {
      throw new Error("private path detail");
    };
    const failed = await f.control.app.inject({
      method: "POST",
      url,
      headers: authenticated,
      payload: { confirm: true },
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.body).not.toContain("private path detail");
    installer.install = async () => result;
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url,
          headers: authenticated,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("does not offer installation in development without a packaged callback", async () => {
    const f = await fixture();
    const authenticated = await f.connect();
    expect(
      (
        await f.control.app.inject({
          method: "GET",
          url: "/local-api/installation",
          headers: authenticated,
        })
      ).json(),
    ).toEqual({ state: "unavailable", destination: null, data: null });
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/installation",
          headers: authenticated,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("does not advertise successful closure without a companion lifecycle callback", async () => {
    const f = await fixture();
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/companion/shutdown",
          headers: await f.connect(),
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(() => f.control.issueBootstrap()).not.toThrow();
  });
  it("accepts only confirmed private shutdown and fences new operations and reentry", async () => {
    let closed = 0;
    const f = await fixture(undefined, () => {
      closed++;
    });
    const url = "/local-api/companion/shutdown";
    expect(
      (await f.hub.inject({ method: "POST", url, payload: { confirm: true } })).statusCode,
    ).toBe(404);
    expect(
      (await f.control.app.inject({ method: "POST", url, headers, payload: { confirm: true } }))
        .statusCode,
    ).toBe(401);
    const authenticated = await f.connect();
    for (const altered of [
      { ...authenticated, origin: "https://example.com" },
      { ...authenticated, host: "example.com" },
    ]) {
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url,
            headers: altered,
            payload: { confirm: true },
          })
        ).statusCode,
      ).toBe(403);
    }
    for (const payload of [{}, { confirm: false }, { confirm: true, pid: 123 }]) {
      expect(
        (await f.control.app.inject({ method: "POST", url, headers: authenticated, payload }))
          .statusCode,
      ).toBe(422);
    }
    expect(closed).toBe(0);
    const response = await f.control.app.inject({
      method: "POST",
      url,
      headers: authenticated,
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ closing: true });
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    expect(closed).toBe(1);
    expect(() => f.control.issueBootstrap()).toThrow("closing");
    for (const blocked of ["/local-api/runtime/start", url, "/local-api/bootstrap"]) {
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url: blocked,
            headers: authenticated,
            payload: { confirm: true },
          })
        ).statusCode,
      ).toBe(409);
    }
    expect(closed).toBe(1);
  });
  it("rejects shutdown during a runtime operation without disrupting it", async () => {
    let closed = 0;
    const f = await fixture(undefined, () => {
      closed++;
    });
    const authenticated = await f.connect();
    let finish: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.runtime.start = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
        entered?.();
      });
    const operation = f.control.app.inject({
      method: "POST",
      url: "/local-api/runtime/start",
      headers: authenticated,
    });
    // inject is thenable: start the request before waiting for the runtime boundary.
    const pending = operation.then((response) => response);
    await started;
    try {
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url: "/local-api/companion/shutdown",
            headers: authenticated,
            payload: { confirm: true },
          })
        ).statusCode,
      ).toBe(409);
      expect(closed).toBe(0);
      expect(() => f.control.issueBootstrap()).not.toThrow();
    } finally {
      finish?.();
      expect((await pending).statusCode).toBe(200);
    }
  });
  it("renews an internal entry after expiry/logout without creating public recovery authority", async () => {
    let time = Date.now();
    const f = await fixture(() => time);
    time += 300001;
    const next = f.control.issueBootstrap();
    const secret = new URLSearchParams(new URL(next).hash.slice(1)).get("local-control");
    const response = await f.control.app.inject({
      method: "POST",
      url: "/local-api/bootstrap",
      headers,
      payload: { secret },
    });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers["set-cookie"]).split(";")[0] as string;
    // Issuing a private entry does not invalidate the active local session before consent.
    const unconsumed = f.control.issueBootstrap();
    expect(
      (await f.control.app.inject({ url: "/local-api/snapshot", headers: { ...headers, cookie } }))
        .statusCode,
    ).toBe(200);
    const latest = f.control.issueBootstrap();
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/bootstrap",
          headers,
          payload: {
            secret: new URLSearchParams(new URL(unconsumed).hash.slice(1)).get("local-control"),
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/logout",
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/bootstrap",
          headers,
          payload: {
            secret: new URLSearchParams(new URL(latest).hash.slice(1)).get("local-control"),
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.hub.inject({ method: "POST", url: "/local-api/reopen" })).statusCode).toBe(404);
  });
  it("creates a workspace with an explicit owner and no MCP token, only on the local listener", async () => {
    const f = await fixture();
    const input = { name: "First team", person: { kind: "new", username: "first-owner" } };
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/workspaces",
          headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await f.hub.inject({ method: "POST", url: "/local-api/workspaces", payload: input }))
        .statusCode,
    ).toBe(404);
    const auth = await f.connect();
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/workspaces",
          headers: { ...auth, origin: "http://attacker.test" },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    const response = await f.control.app.inject({
      method: "POST",
      url: "/local-api/workspaces",
      headers: auth,
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    const { user, project } = response.json();
    expect(user.username).toBe("first-owner");
    expect(project.name).toBe("First team");
    expect(f.hub.ctx.projectService.checkMembership(project.project_id, user.user_id).role).toBe(
      "owner",
    );
    expect(f.hub.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n).toBe(0);
    expect(f.runtime.status().hub).toBe("stopped");
    expect(
      (
        await f.control.app.inject({
          method: "POST",
          url: "/local-api/workspaces",
          headers: auth,
          payload: input,
        })
      ).statusCode,
    ).toBe(409);
    const existing = await f.control.app.inject({
      method: "POST",
      url: "/local-api/workspaces",
      headers: auth,
      payload: { name: "Second team", person: { kind: "existing", user_id: user.user_id } },
    });
    expect(existing.statusCode).toBe(200);
    expect(existing.json().user.user_id).toBe(user.user_id);
    expect(f.hub.ctx.db.prepare("SELECT COUNT(*) n FROM users").get()?.n).toBe(1);
    expect(f.hub.ctx.db.prepare("SELECT COUNT(*) n FROM auth_tokens").get()?.n).toBe(0);
  });

  it("rolls back all workspace entities, auditing and events when composition fails", async () => {
    const f = await fixture();
    const auth = await f.connect();
    const events: string[] = [];
    const unsubscribe = f.hub.ctx.eventBus.subscribe((event) => events.push(event.type));
    try {
      f.hub.ctx.db.exec(
        "CREATE TRIGGER fail_workspace BEFORE INSERT ON audit_entries WHEN NEW.action = 'workspace.create' BEGIN SELECT RAISE(ABORT, 'fail'); END;",
      );
      const input = { name: "Rollback team", person: { kind: "new", username: "rollback-owner" } };
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url: "/local-api/workspaces",
            headers: auth,
            payload: input,
          })
        ).statusCode,
      ).toBe(500);
      for (const table of [
        "users",
        "projects",
        "memberships",
        "auth_tokens",
        "events",
        "audit_entries",
      ])
        expect(f.hub.ctx.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(0);
      expect(events).toEqual([]);
      f.hub.ctx.db.exec("DROP TRIGGER fail_workspace;");
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url: "/local-api/workspaces",
            headers: auth,
            payload: input,
          })
        ).statusCode,
      ).toBe(200);
      expect(events).toEqual(["project.created"]);
    } finally {
      unsubscribe();
    }
  });

  it("rejects invalid or implicit workspace identities without partial provisioning", async () => {
    const f = await fixture();
    const auth = await f.connect();
    for (const input of [
      { name: " ", person: { kind: "new", username: "good" } },
      { name: "Team", person: { kind: "new", username: "bad name" } },
      { name: "Team", person: { kind: "existing", user_id: crypto.randomUUID() } },
      { name: "Team", person: { username: "good" } },
      { name: "Team", person: { kind: "new", username: "good", user_id: crypto.randomUUID() } },
    ]) {
      expect(
        (
          await f.control.app.inject({
            method: "POST",
            url: "/local-api/workspaces",
            headers: auth,
            payload: input,
          })
        ).statusCode,
      ).toBe(422);
    }
    expect(f.hub.ctx.db.prepare("SELECT COUNT(*) n FROM users").get()?.n).toBe(0);
  });

  it("never exposes administrative routes on the public Hub or accepts project tokens as local authority", async () => {
    const { hub, control } = await fixture();
    const token = hub.ctx.authService.createToken(crypto.randomUUID(), "agents-hub");
    expect(
      (
        await hub.inject({
          method: "POST",
          url: "/local-api/users",
          headers: { authorization: `Bearer ${token}` },
          payload: { username: "intruder" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await control.app.inject({
          url: "/local-api/snapshot",
          headers: { ...headers, authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await control.app.inject({
          url: "/local-api/snapshot",
          headers: { ...headers, host: "attacker.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await control.app.inject({
          url: "/local-api/snapshot",
          headers,
          remoteAddress: "192.0.2.1",
        })
      ).statusCode,
    ).toBe(403);
  });
  it("uses one-use bootstrap, local cookie, origin checks, expiry and logout", async () => {
    let now = Date.now();
    const { control, secret, connect } = await fixture(() => now);
    expect(
      (
        await control.app.inject({
          method: "POST",
          url: "/local-api/bootstrap",
          headers: { ...headers, origin: "https://evil.test" },
          payload: { secret },
        })
      ).statusCode,
    ).toBe(403);
    const authenticated = await connect();
    expect(
      (
        await control.app.inject({
          method: "POST",
          url: "/local-api/bootstrap",
          headers,
          payload: { secret },
        })
      ).statusCode,
    ).toBe(401);
    const snapshot = await control.app.inject({
      url: "/local-api/snapshot",
      headers: authenticated,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await control.app.inject({
          url: "/local-api/snapshot",
          headers: { ...headers, cookie: `ah_local=${"é".repeat(43)}` },
        })
      ).statusCode,
    ).toBe(401);
    for (const badHeaders of [
      { ...authenticated, origin: "https://evil.test" },
      { host: headers.host, cookie: authenticated.cookie },
      { ...authenticated, "sec-fetch-site": "cross-site" },
    ])
      expect(
        (
          await control.app.inject({
            method: "POST",
            url: "/local-api/users",
            headers: badHeaders,
            payload: { username: "bad" },
          })
        ).statusCode,
      ).toBe(403);
    now += 28800001;
    expect(
      (await control.app.inject({ url: "/local-api/snapshot", headers: authenticated })).statusCode,
    ).toBe(401);
    const second = await fixture();
    const session = await second.connect();
    const logout = await second.control.app.inject({
      method: "POST",
      url: "/local-api/logout",
      headers: session,
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict");
    expect(
      (await second.control.app.inject({ url: "/local-api/snapshot", headers: session }))
        .statusCode,
    ).toBe(401);
  });
  it("rejects expired bootstrap before creating authority", async () => {
    let now = Date.now();
    const { control, secret } = await fixture(() => now);
    now += 300001;
    expect(
      (
        await control.app.inject({
          method: "POST",
          url: "/local-api/bootstrap",
          headers,
          payload: { secret },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("provisions and audits atomically, returns secrets only on emission, binds/revokes access", async () => {
    const { hub, control, connect } = await fixture();
    const auth = await connect();
    const create = (username: string) =>
      control.app.inject({
        method: "POST",
        url: "/local-api/users",
        headers: auth,
        payload: { username },
      });
    expect((await create("invalid name")).statusCode).toBe(422);
    hub.ctx.db.exec(
      "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'forced'); END;",
    );
    expect((await create("rollback")).statusCode).toBe(500);
    expect(hub.ctx.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(hub.ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_tokens").get()).toEqual({ n: 0 });
    hub.ctx.db.exec("DROP TRIGGER fail_admin_audit");
    const created = await create("owner");
    expect(created.statusCode).toBe(200);
    const { user, access } = created.json();
    expect((await create("owner")).statusCode).toBe(409);
    const project = await control.app.inject({
      method: "POST",
      url: "/local-api/projects",
      headers: auth,
      payload: { name: "Local project", user_id: user.user_id },
    });
    expect(project.statusCode).toBe(200);
    const projectId = project.json().project_id;
    const issued = await control.app.inject({
      method: "POST",
      url: `/local-api/users/${user.user_id}/accesses`,
      headers: auth,
      payload: { project_id: projectId, ttl_seconds: 60 },
    });
    expect(issued.statusCode).toBe(200);
    expect(hub.ctx.authService.verifyToken(issued.json().token).projectId).toBe(projectId);
    const invitation = await control.app.inject({
      method: "POST",
      url: `/local-api/projects/${projectId}/invitations`,
      headers: auth,
      payload: { role: "collaborator", ttl_seconds: 86400 },
    });
    expect(invitation.statusCode).toBe(200);
    const snapshot = await control.app.inject({ url: "/local-api/snapshot", headers: auth });
    expect(snapshot.body).not.toContain(access.token);
    expect(snapshot.body).not.toContain("token_hash");
    expect(snapshot.body).not.toContain(invitation.json().token);
    expect(
      (
        await control.app.inject({
          method: "DELETE",
          url: `/local-api/accesses/${access.token_id}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(() => hub.ctx.authService.verifyToken(access.token)).toThrow();
  });
  it("serializes lifecycle changes rather than starting duplicate processes", async () => {
    const { control, runtime, connect } = await fixture();
    const auth = await connect();
    let complete: (() => void) | undefined;
    runtime.start = () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      });
    const starting = control.app.inject({
      method: "POST",
      url: "/local-api/runtime/start",
      headers: auth,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      (await control.app.inject({ method: "POST", url: "/local-api/runtime/start", headers: auth }))
        .statusCode,
    ).toBe(409);
    complete?.();
    expect((await starting).statusCode).toBe(200);
  });
});

it("closes the owned Hub even if tunnel shutdown fails", async () => {
  const db = createDatabase(":memory:");
  let fail = true;
  const runtime = await CompanionRuntime.create(
    loadConfig({ DATABASE_URL: ":memory:", PORT: "1298", HOST: "127.0.0.1", LOG_LEVEL: "fatal" }),
    db,
    {
      url: () => null,
      start: async () => "https://example.com",
      stop: async () => {
        if (fail) throw new Error("Own tunnel shutdown failed");
      },
    },
  );
  cleanups.push(async () => {
    fail = false;
    await runtime.stop();
    db.close();
  });
  await runtime.start();
  await expect(runtime.stop()).rejects.toThrow("Own tunnel shutdown failed");
  expect(runtime.status().hub).toBe("stopped");
});

it("starts/stops/restarts only its own Hub and preserves the DB after a port conflict", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as { port: number }).port;
  const db = createDatabase(":memory:");
  let url: string | null = null;
  const runtime = await CompanionRuntime.create(
    loadConfig({ PORT: String(port), NODE_ENV: "production" }),
    db,
    {
      url: () => url,
      start: async () => {
        url = "https://example.trycloudflare.com";
        return url;
      },
      stop: async () => {
        url = null;
      },
    },
  );
  cleanups.push(async () => {
    await runtime.stop();
    db.close();
    if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
  await expect(runtime.start()).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  expect(occupied.listening).toBe(true);
  expect(runtime.status().hub).toBe("stopped");
  await new Promise<void>((resolve) => occupied.close(() => resolve()));
  db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(
    crypto.randomUUID(),
    "persisted",
    new Date().toISOString(),
  );
  await runtime.start();
  expect((await fetch(`http://127.0.0.1:${port}/health/live`)).ok).toBe(true);
  await runtime.share();
  expect(runtime.status().sharing).toBe("running");
  await runtime.stopSharing();
  expect(runtime.status().hub).toBe("running");
  await runtime.stop();
  await runtime.start();
  expect(db.prepare("SELECT username FROM users").get()).toEqual({ username: "persisted" });
});

it("restores the previous Hub state when public tunnel readiness fails", async () => {
  const reserved = createServer();
  await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = (reserved.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const db = createDatabase(":memory:");
  let address: string | null = null;
  const runtime = await CompanionRuntime.create(
    loadConfig({ PORT: String(port), NODE_ENV: "production", LOG_LEVEL: "fatal" }),
    db,
    {
      url: () => address,
      start: async () => {
        address = "https://fixture.trycloudflare.com";
        return address;
      },
      stop: async () => {
        address = null;
      },
      ready: async () => {
        throw new Error("DNS not ready");
      },
    },
  );
  cleanups.push(async () => {
    await runtime.stop();
    db.close();
  });
  for (const running of [false, true]) {
    if (running) await runtime.start();
    await expect(runtime.share()).rejects.toThrow("DNS not ready");
    expect(runtime.status()).toEqual({
      hub: running ? "running" : "stopped",
      sharing: "stopped",
      portal_url: running ? `http://127.0.0.1:${port}` : null,
    });
    if (running) expect((await fetch(`http://127.0.0.1:${port}/health/live`)).ok).toBe(true);
  }
});
