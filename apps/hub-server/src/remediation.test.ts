import { decodeCursor, encodeCursor } from "@agents-hub/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    app.ctx.db.close();
  }
});

function room() {
  const app = buildApp();
  apps.push(app);
  const user = crypto.randomUUID();
  const project = app.ctx.projectService.createProject("Shared", user).project;
  const token = app.ctx.authService.createToken(user, "agents-hub");
  const session = app.ctx.sessionService.joinProject(project.project_id, "alice", user);
  const headers = { authorization: `Bearer ${token}` };
  const root = `/v1/projects/${project.project_id}`;
  return { app, user, project, token, session, headers, root };
}

describe("Locks, cursors, authorization and idempotency regressions", () => {
  it("limits incoming WebSocket frames to 64 KiB", async () => {
    const { app, project, user, session, token } = room();
    const auth = app.ctx.authService.verifyToken(token);
    const ticket = app.ctx.wsTicketService.createTicket(
      user,
      project.project_id,
      session.session_id,
      30,
      auth.tokenId,
    );
    await app.ready();
    let connected: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const socket = await app.injectWS(
      `/v1/projects/${project.project_id}/events?session_id=${session.session_id}&ticket=${ticket}`,
      { headers: { origin: "http://localhost:5173" } },
      {
        onInit: (ws) => {
          ws.once("message", () => connected());
        },
      },
    );
    await ready;
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(Buffer.alloc(65537));
    expect(await closed).toBe(1009);
    socket.terminate();
  });
  it("canonicalizes trailing slashes and rejects descendant/ancestor claims", () => {
    const { app, project } = room();
    const lock = app.ctx.lockService.claimLock(project.project_id, "alice", {
      paths: ["src\\api//"],
      reason: "edit",
    });
    expect(lock.paths).toEqual(["src/api"]);
    for (const path of ["src/api", "src/api/file.ts", "src/"])
      expect(() =>
        app.ctx.lockService.claimLock(project.project_id, "bob", {
          paths: [path],
          reason: "conflict",
        }),
      ).toThrow(/LOCK_CONFLICT/);
  });

  it.each([0, -1, 3601, 86400, 1.5, "300", null])(
    "rejects invalid renewal TTL %s without changing lock/event",
    async (ttl) => {
      const { app, project, session, headers, root } = room();
      const lock = app.ctx.lockService.claimLock(project.project_id, "alice", {
        paths: ["src/api"],
        reason: "edit",
      });
      const before = app.ctx.eventBus.getMaxSequence(project.project_id);
      const response = await app.inject({
        method: "POST",
        url: `${root}/locks/${lock.lock_id}/renew`,
        headers,
        payload: { session_id: session.session_id, ttl_seconds: ttl },
      });
      expect(response.statusCode).toBe(422);
      expect(app.ctx.lockService.getActiveLocks(project.project_id)[0]?.expires_at).toBe(
        lock.expires_at,
      );
      expect(app.ctx.eventBus.getMaxSequence(project.project_id)).toBe(before);
    },
  );

  it("expires locks once and keeps sequence monotonic after retention", () => {
    const { app, project } = room();
    app.ctx.lockService.claimLock(project.project_id, "alice", {
      paths: ["src/api"],
      reason: "edit",
    });
    app.ctx.db.prepare("UPDATE workspace_locks SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(app.ctx.lockService.expireLocks()).toBe(1);
    expect(app.ctx.lockService.expireLocks()).toBe(0);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM workspace_locks").get()?.n).toBe(0);
    const events = app.ctx.eventBus.getEventsAfter(project.project_id);
    expect(events.filter((e) => e.type === "lock.expired")).toHaveLength(1);
    const before = app.ctx.eventBus.getMaxSequence(project.project_id);
    app.ctx.db.prepare("DELETE FROM events").run();
    const after = app.ctx.eventBus.recordEvent(project.project_id, "alice", "agent.heartbeat", {
      agent_id: "alice",
    });
    expect(after.sequence).toBe(before + 1);
  });

  it("accepts cursor zero, rejects noncanonical cursors and does not regress ACK", async () => {
    const { app, project, root, session, headers } = room();
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    for (const raw of ["1foo", "01", "-1", "1.5", "9007199254740992"])
      expect(decodeCursor(Buffer.from(raw).toString("base64url"))).toBeNull();
    const max = app.ctx.eventBus.getMaxSequence(project.project_id);
    for (const seq of [max, 0, 1, max]) {
      const res = await app.inject({
        method: "POST",
        url: `${root}/inbox/ack`,
        headers,
        payload: { session_id: session.session_id, cursor: encodeCursor(seq) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.cursor).toBe(encodeCursor(max));
    }
  });

  it("returns input/size errors and rejects unknown recipients", async () => {
    const { app, root, session, headers } = room();
    expect(
      (await app.inject({ method: "POST", url: "/v1/projects", headers, payload: { name: 123 } }))
        .statusCode,
    ).toBe(422);
    const tooLarge = await app.inject({
      method: "POST",
      url: `${root}/messages`,
      headers,
      payload: { session_id: session.session_id, body: "x".repeat(16385) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe("MESSAGE_TOO_LARGE");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${root}/messages`,
          headers,
          payload: {
            session_id: session.session_id,
            body: "hello",
            recipient_agent_ids: ["absent"],
          },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("replays committed responses without duplicate entity/event and rejects payload reuse", async () => {
    const { app, root, session, headers, project } = room();
    const request = {
      method: "POST" as const,
      url: `${root}/messages`,
      headers: { ...headers, "idempotency-key": "lost-response" },
      payload: { session_id: session.session_id, body: "one message" },
    };
    const first = await app.inject(request);
    const before = app.ctx.eventBus.getMaxSequence(project.project_id);
    const repeated = await app.inject(request);
    expect(repeated.json().data).toEqual(first.json().data);
    expect(app.ctx.eventBus.getMaxSequence(project.project_id)).toBe(before);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(1);
    const conflict = await app.inject({
      ...request,
      payload: { ...request.payload, body: "different" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const claim = {
      method: "POST" as const,
      url: `${root}/locks/claim`,
      headers: { ...headers, "idempotency-key": "lock-response" },
      payload: { session_id: session.session_id, paths: ["src/api"], reason: "edit" },
    };
    const a = await app.inject(claim);
    const b = await app.inject(claim);
    expect(a.json().data.lock_id).toBe(b.json().data.lock_id);
    expect(app.ctx.lockService.getActiveLocks(project.project_id)).toHaveLength(1);
  });

  it("rolls back nested domain commands and discards notifications", () => {
    const { app, project } = room();
    const observed: string[] = [];
    app.ctx.eventBus.subscribe((e) => observed.push(e.type));
    expect(() =>
      app.ctx.idempotencyService.execute(
        "user",
        project.project_id,
        "claim",
        "rollback",
        {},
        () => {
          app.ctx.lockService.claimLock(project.project_id, "alice", {
            paths: ["src/api"],
            reason: "edit",
          });
          throw new Error("lost transaction");
        },
      ),
    ).toThrow("lost transaction");
    expect(app.ctx.lockService.getActiveLocks(project.project_id)).toHaveLength(0);
    expect(observed).toEqual([]);
  });

  it("rejects ticket handshake after membership/token revocation and closes active access", async () => {
    const { app, project, user, session, token } = room();
    await app.ready();
    const auth = app.ctx.authService.verifyToken(token);
    const connect = async (ticket: string) => {
      let resolve: (value: string) => void = () => {};
      const outcome = new Promise<string>((r) => {
        resolve = r;
      });
      const socket = await app.injectWS(
        `/v1/projects/${project.project_id}/events?session_id=${session.session_id}&ticket=${ticket}`,
        { headers: { origin: "http://localhost:5173" } },
        {
          onInit: (ws) => {
            ws.once("message", (data) => resolve(JSON.parse(data.toString()).type));
            ws.once("close", (code) => resolve(`close:${code}`));
          },
        },
      );
      return { socket, outcome };
    };
    const active = await connect(
      app.ctx.wsTicketService.createTicket(
        user,
        project.project_id,
        session.session_id,
        30,
        auth.tokenId,
      ),
    );
    expect(await active.outcome).toBe("connected");
    const closed = new Promise<number>((r) => active.socket.once("close", r));
    app.ctx.authService.revokeToken(auth.tokenId);
    app.ctx.wsHub.revalidate();
    expect(await closed).toBe(1008);
    active.socket.terminate();
    const invalid = await connect(
      app.ctx.wsTicketService.createTicket(
        user,
        project.project_id,
        session.session_id,
        30,
        auth.tokenId,
      ),
    );
    expect(await invalid.outcome).toBe("close:1008");
    invalid.socket.terminate();
    app.ctx.db.prepare("DELETE FROM memberships WHERE project_id = ?").run(project.project_id);
    const removed = await connect(
      app.ctx.wsTicketService.createTicket(user, project.project_id, session.session_id),
    );
    expect(await removed.outcome).toBe("close:1008");
    removed.socket.terminate();
  });
});
