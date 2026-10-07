import type { AddressInfo } from "node:net";
import { encodeCursor } from "@agents-hub/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, buildApp } from "./app.js";
import { createDatabase } from "./infrastructure/db/database.js";

describe("Hub Server Network & API (Phase 3)", () => {
  let app: FastifyInstance & { ctx: AppContext };
  let authToken: string;
  let testUserId: string;
  let openSockets: globalThis.WebSocket[];

  beforeEach(() => {
    openSockets = [];
    const db = createDatabase(":memory:");
    app = buildApp({}, db);
    testUserId = "user-alice";
    authToken = app.ctx.authService.createToken(testUserId, "agents-hub");
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      try {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore socket close errors
      }
    }
    openSockets = [];
    await app.close();
  });

  describe("Health & Middleware", () => {
    it("responds to /health/live and /health/ready with x-request-id", async () => {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
      expect(res.headers["x-request-id"]).toBeDefined();
    });

    it("rejects unauthenticated requests to protected endpoints with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "Test Project" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("Project Creation & Sessions", () => {
    it("creates a project with valid token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${authToken}` },
        payload: { name: "Agents Room" },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json().data;
      expect(data.project.name).toBe("Agents Room");
      expect(data.membership.role).toBe("owner");
    });

    it("joins agent session and reports heartbeat", async () => {
      const proj = app.ctx.projectService.createProject("Room 1", testUserId).project;

      const sessionRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/sessions`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: { agent_id: "agent-terminal-1" },
      });

      expect(sessionRes.statusCode).toBe(201);
      const session = sessionRes.json().data;
      expect(session.agent_id).toBe("agent-terminal-1");

      const hbRes = await app.inject({
        method: "POST",
        url: `/v1/sessions/${session.session_id}/heartbeat`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: { project_id: proj.project_id, agent_id: "agent-terminal-1" },
      });
      expect(hbRes.statusCode).toBe(200);
    });
  });

  describe("Messages & Inbox Pagination via Cursors", () => {
    it("sends message and retrieves it via /inbox with cursor", async () => {
      const proj = app.ctx.projectService.createProject("Chat Project", testUserId).project;

      // Join session for Alice
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );

      // Alice sends message
      const sendRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/messages`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          body: "Hello from terminal A",
          channel: "general",
        },
      });
      expect(sendRes.statusCode).toBe(201);

      // Check inbox
      const inboxRes = await app.inject({
        method: "GET",
        url: `/v1/projects/${proj.project_id}/inbox?session_id=${aliceSession.session_id}`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(inboxRes.statusCode).toBe(200);
      const inbox = inboxRes.json().data;
      expect(inbox.events.length).toBeGreaterThan(0);
      expect(inbox.next_cursor).toBeDefined();

      // Query again with after cursor
      const emptyInboxRes = await app.inject({
        method: "GET",
        url: `/v1/projects/${proj.project_id}/inbox?session_id=${aliceSession.session_id}&after=${inbox.next_cursor}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(emptyInboxRes.json().data.events.length).toBe(0);
    });
  });

  describe("Workspace Locks (API)", () => {
    it("claims lock and rejects conflict with 409", async () => {
      const proj = app.ctx.projectService.createProject("Lock Project", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );
      const bobSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-bob",
        testUserId,
      );

      const claimRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          paths: ["src/index.ts"],
          reason: "Updating entrypoint",
        },
      });
      expect(claimRes.statusCode).toBe(201);

      // Bob claims conflicting lock -> 409
      const conflictRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: bobSession.session_id,
          paths: ["src/index.ts"],
          reason: "Trying to edit",
        },
      });
      expect(conflictRes.statusCode).toBe(409);
      expect(conflictRes.json().error.code).toBe("LOCK_CONFLICT");
    });
  });

  describe("Team Status API", () => {
    it("returns combined team status", async () => {
      const proj = app.ctx.projectService.createProject("Team Room", testUserId).project;
      app.ctx.sessionService.joinProject(proj.project_id, "agent-1", testUserId);
      app.ctx.statusService.reportStatus(proj.project_id, "agent-1", {
        objective: "Testing team status",
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/projects/${proj.project_id}/team-status`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.active_agents.length).toBe(1);
      expect(data.statuses.length).toBe(1);
    });
  });

  describe("Security Boundaries & Targeted Visibility (Audit P0 Fixes)", () => {
    it("prevents impersonation: rejects message when session_id belongs to another user", async () => {
      const proj = app.ctx.projectService.createProject("Sec Room", testUserId).project;
      const otherUserId = "user-bob";
      app.ctx.db
        .prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)")
        .run(otherUserId, "bob", new Date().toISOString());
      app.ctx.projectService.checkMembership = () => ({
        membership_id: "m-1",
        project_id: proj.project_id,
        user_id: otherUserId,
        role: "collaborator",
        created_at: "",
      });
      const bobSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-bob",
        otherUserId,
      );

      // Alice tries to send message claiming bob's session
      const res = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/messages`,
        headers: { authorization: `Bearer ${authToken}` }, // Alice's token
        payload: {
          session_id: bobSession.session_id, // Bob's session
          body: "Forged message",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    });

    it("isolates targeted messages: Charlie cannot see message from Alice to Bob in inbox", async () => {
      const proj = app.ctx.projectService.createProject("Private Chat", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );
      const bobSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-bob",
        testUserId,
      );
      const charlieSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-charlie",
        testUserId,
      );

      // Alice sends targeted message to Bob
      await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/messages`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          body: "Secret contract for Bob only",
          recipient_agent_ids: ["agent-bob"],
        },
      });

      // Bob's inbox: MUST see the message
      const bobInboxRes = await app.inject({
        method: "GET",
        url: `/v1/projects/${proj.project_id}/inbox?session_id=${bobSession.session_id}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      const bobEvents = bobInboxRes.json().data.events;
      expect(
        bobEvents.some(
          (e: { payload: { body?: string } }) => e.payload.body === "Secret contract for Bob only",
        ),
      ).toBe(true);

      // Charlie's inbox: MUST NOT see the message
      const charlieInboxRes = await app.inject({
        method: "GET",
        url: `/v1/projects/${proj.project_id}/inbox?session_id=${charlieSession.session_id}`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      const charlieEvents = charlieInboxRes.json().data.events;
      expect(
        charlieEvents.some(
          (e: { payload: { body?: string } }) => e.payload.body === "Secret contract for Bob only",
        ),
      ).toBe(false);
    });

    it("supports lock renewal and release by lockId", async () => {
      const proj = app.ctx.projectService.createProject("Lock Renew Room", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );

      // Claim lock
      const claimRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          paths: ["src/critical.ts"],
          reason: "Working on critical bug",
          ttl_seconds: 60,
        },
      });
      expect(claimRes.statusCode).toBe(201);
      const lockId = claimRes.json().data.lock_id;

      // Renew lock
      const renewRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/${lockId}/renew`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          ttl_seconds: 300,
        },
      });
      expect(renewRes.statusCode).toBe(200);
      expect(renewRes.json().data.ttl_seconds).toBe(300);

      // Release lock by ID
      const releaseRes = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${proj.project_id}/locks/${lockId}`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
        },
      });
      expect(releaseRes.statusCode).toBe(200);

      // Confirm lock is gone
      const activeLocks = app.ctx.lockService.getActiveLocks(proj.project_id);
      expect(activeLocks.length).toBe(0);
    });

    it("rejects GET /inbox without session_id with 422 INVALID_INPUT", async () => {
      const proj = app.ctx.projectService.createProject("No Sess Room", testUserId).project;
      const res = await app.inject({
        method: "GET",
        url: `/v1/projects/${proj.project_id}/inbox`,
        headers: { authorization: `Bearer ${authToken}` },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("INVALID_INPUT");
    });

    it("rejects ACK with malformed cursor or sequence exceeding existing project events", async () => {
      const proj = app.ctx.projectService.createProject("Ack Fail Room", testUserId).project;
      const session = app.ctx.sessionService.joinProject(proj.project_id, "ag-ack", testUserId);

      // 1. Malformed cursor string
      const badCursorRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/inbox/ack`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: session.session_id,
          cursor: "not-a-valid-base64url-cursor!@#$",
        },
      });
      expect(badCursorRes.statusCode).toBe(400);
      expect(badCursorRes.json().error.code).toBe("CURSOR_INVALID");

      // 2. Future cursor exceeding existing sequence
      const futureCursor = encodeCursor(9999);
      const futureRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/inbox/ack`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: session.session_id,
          cursor: futureCursor,
        },
      });
      expect(futureRes.statusCode).toBe(400);
      expect(futureRes.json().error.code).toBe("CURSOR_INVALID");
    });

    it("acknowledges valid cursor using POST /inbox/ack", async () => {
      const proj = app.ctx.projectService.createProject("Ack Room", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );
      // Project creation + session join created events with sequences 1 and 2
      const validCursor = encodeCursor(1);

      const ackRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/inbox/ack`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          cursor: validCursor,
        },
      });

      expect(ackRes.statusCode).toBe(200);
      expect(ackRes.json().data.cursor).toBe(validCursor);

      const session = app.ctx.sessionService.getSessionById(aliceSession.session_id);
      expect(session?.last_cursor).toBe(validCursor);
    });

    it("expires locks after TTL allowing another agent to claim the path", async () => {
      const proj = app.ctx.projectService.createProject("Expire Room", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );
      const bobSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-bob",
        testUserId,
      );

      // Alice claims with 1 second TTL
      const claimRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          paths: ["src/temp.ts"],
          reason: "Quick fix",
          ttl_seconds: 1,
        },
      });
      expect(claimRes.statusCode).toBe(201);

      // Wait 1.1s for lock to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Bob claims the same path -> MUST succeed now without 409
      const bobClaimRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: bobSession.session_id,
          paths: ["src/temp.ts"],
          reason: "Bob now editing",
          ttl_seconds: 60,
        },
      });
      expect(bobClaimRes.statusCode).toBe(201);
      expect(bobClaimRes.json().data.owner_agent_id).toBe("agent-bob");
    });
  });

  describe("WebSocket Real-Time Broadcast & Security", () => {
    it("connects and receives welcome message on valid credentials", async () => {
      await app.listen({ port: 0 });
      const addr = app.server.address() as AddressInfo;

      const proj = app.ctx.projectService.createProject("WS Room", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );

      const wsUrl = `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}&session_id=${aliceSession.session_id}`;
      const ws = new globalThis.WebSocket(wsUrl, { headers: { Origin: "http://localhost:5173" } });
      openSockets.push(ws);

      const received = await new Promise<{ type: string; projectId: string; agentId: string }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WS message timeout")), 3000);
          ws.onmessage = (e) => {
            clearTimeout(timeout);
            resolve(JSON.parse(String(e.data)));
          };
          ws.onerror = (e) => {
            clearTimeout(timeout);
            reject(e);
          };
        },
      );

      expect(received.type).toBe("connected");
      expect(received.projectId).toBe(proj.project_id);
      expect(received.agentId).toBe("agent-alice");
    });

    it("closes with code 1008 if token is missing or invalid", async () => {
      await app.listen({ port: 0 });
      const addr = app.server.address() as AddressInfo;

      const proj = app.ctx.projectService.createProject("WS Reject Room", testUserId).project;
      const wsUrl = `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=invalid_token`;
      const ws = new globalThis.WebSocket(wsUrl, { headers: { Origin: "http://localhost:5173" } });
      openSockets.push(ws);

      const code = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WS close timeout")), 3000);
        ws.onclose = (e) => {
          clearTimeout(timeout);
          resolve(e.code);
        };
      });

      expect(code).toBe(1008);
    });

    it("broadcasts messages in real-time and isolates targeted messages between agents", async () => {
      await app.listen({ port: 0 });
      const addr = app.server.address() as AddressInfo;

      const proj = app.ctx.projectService.createProject("WS Broadcast Room", testUserId).project;
      const aliceSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-alice",
        testUserId,
      );
      const bobSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-bob",
        testUserId,
      );
      const charlieSession = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-charlie",
        testUserId,
      );

      // Connect Bob and Charlie
      const bobWs = new globalThis.WebSocket(
        `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}&session_id=${bobSession.session_id}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      openSockets.push(bobWs);

      const charlieWs = new globalThis.WebSocket(
        `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}&session_id=${charlieSession.session_id}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      openSockets.push(charlieWs);

      // Wait for both to be connected
      await Promise.all([
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Bob WS connect timeout")), 3000);
          bobWs.onmessage = () => {
            clearTimeout(timeout);
            resolve(true);
          };
        }),
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Charlie WS connect timeout")), 3000);
          charlieWs.onmessage = () => {
            clearTimeout(timeout);
            resolve(true);
          };
        }),
      ]);

      const bobEvents: Array<{ data?: { payload?: { body?: string } } }> = [];
      const charlieEvents: Array<{ data?: { payload?: { body?: string } } }> = [];

      bobWs.onmessage = (e) => bobEvents.push(JSON.parse(String(e.data)));
      charlieWs.onmessage = (e) => charlieEvents.push(JSON.parse(String(e.data)));

      // Alice sends targeted message to Bob only
      await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/messages`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          session_id: aliceSession.session_id,
          body: "Direct message for Bob only",
          recipient_agent_ids: ["agent-bob"],
        },
      });

      // Wait a moment for WS propagation
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Bob MUST receive it
      expect(bobEvents.some((e) => e.data?.payload?.body === "Direct message for Bob only")).toBe(
        true,
      );

      // Charlie MUST NOT receive it
      expect(
        charlieEvents.some((e) => e.data?.payload?.body === "Direct message for Bob only"),
      ).toBe(false);
    });

    it("closes with code 1008 if session_id is missing", async () => {
      await app.listen({ port: 0 });
      const addr = app.server.address() as AddressInfo;

      const proj = app.ctx.projectService.createProject("WS No Sess", testUserId).project;
      const wsUrl = `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}`;
      const ws = new globalThis.WebSocket(wsUrl, { headers: { Origin: "http://localhost:5173" } });
      openSockets.push(ws);

      const code = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WS close timeout")), 3000);
        ws.onclose = (e) => {
          clearTimeout(timeout);
          resolve(e.code);
        };
      });

      expect(code).toBe(1008);
    });

    it("closes with code 1008 if Origin header is absent or invalid in restricted CORS mode", async () => {
      // Create an app instance with strict origin (not wildcard)
      const strictApp = buildApp({ CORS_ORIGINS: "http://allowed.app.com" }, app.ctx.db);
      await strictApp.listen({ port: 0 });
      const addr = strictApp.server.address() as AddressInfo;

      const proj = strictApp.ctx.projectService.createProject(
        "Strict Origin Room",
        testUserId,
      ).project;
      const session = strictApp.ctx.sessionService.joinProject(
        proj.project_id,
        "ag-strict",
        testUserId,
      );

      try {
        // 1. Missing Origin header
        const wsNoOrigin = new globalThis.WebSocket(
          `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}&session_id=${session.session_id}`,
        );
        openSockets.push(wsNoOrigin);

        const codeNoOrigin = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WS close timeout")), 3000);
          wsNoOrigin.onclose = (e) => {
            clearTimeout(timeout);
            resolve(e.code);
          };
        });
        expect(codeNoOrigin).toBe(1008);

        // 2. Invalid Origin header
        const wsBadOrigin = new globalThis.WebSocket(
          `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}&session_id=${session.session_id}`,
          { headers: { Origin: "http://attacker.com" } },
        );
        openSockets.push(wsBadOrigin);

        const codeBadOrigin = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WS close timeout")), 3000);
          wsBadOrigin.onclose = (e) => {
            clearTimeout(timeout);
            resolve(e.code);
          };
        });
        expect(codeBadOrigin).toBe(1008);
      } finally {
        await strictApp.close();
      }
    });

    it("rejects token in query string when in production mode", async () => {
      const prodApp = buildApp(
        { NODE_ENV: "production", CORS_ORIGINS: "http://localhost:5173" },
        app.ctx.db,
      );
      await prodApp.listen({ port: 0 });
      const addr = prodApp.server.address() as AddressInfo;

      const proj = prodApp.ctx.projectService.createProject("Prod WS Room", testUserId).project;
      const session = prodApp.ctx.sessionService.joinProject(
        proj.project_id,
        "ag-prod",
        testUserId,
      );

      try {
        // Query param token should be rejected in production
        const ws = new globalThis.WebSocket(
          `ws://127.0.0.1:${addr.port}/v1/projects/${proj.project_id}/events?token=${authToken}&session_id=${session.session_id}`,
          { headers: { Origin: "http://localhost:5173" } },
        );
        openSockets.push(ws);

        const code = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WS close timeout")), 3000);
          ws.onclose = (e) => {
            clearTimeout(timeout);
            resolve(e.code);
          };
        });

        expect(code).toBe(1008);
      } finally {
        await prodApp.close();
      }
    });
  });

  describe("Scope Authorization Enforcement", () => {
    it("enforces scope boundaries and rejects insufficient permissions with 403", async () => {
      const readOnlyToken = app.ctx.authService.createToken(testUserId, "agents-hub", [
        "projects:read",
        "messages:read",
      ]);
      const proj = app.ctx.projectService.createProject("Scope Room", testUserId).project;
      const session = app.ctx.sessionService.joinProject(
        proj.project_id,
        "agent-scope",
        testUserId,
      );

      // Attempting to send message requires messages:write -> should fail 403
      const msgRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/messages`,
        headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: {
          session_id: session.session_id,
          body: "Trying to write with read-only token",
        },
      });
      expect(msgRes.statusCode).toBe(403);
      expect(msgRes.json().error.code).toBe("FORBIDDEN");

      // Attempting to claim lock requires locks:write -> should fail 403
      const lockRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${proj.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: {
          session_id: session.session_id,
          paths: ["src/index.ts"],
          reason: "Read token claiming lock",
        },
      });
      expect(lockRes.statusCode).toBe(403);
      expect(lockRes.json().error.code).toBe("FORBIDDEN");
    });
  });

  describe("Event Bus Transactional Integrity", () => {
    it("does not notify subscribers when a transaction is rolled back", () => {
      const proj = app.ctx.projectService.createProject("Tx Rollback Room", testUserId).project;
      const capturedEvents: unknown[] = [];
      const unsubscribe = app.ctx.eventBus.subscribe((ev) => {
        if (ev.project_id === proj.project_id) {
          capturedEvents.push(ev);
        }
      });

      // Execute transaction that throws
      expect(() => {
        app.ctx.eventBus.transaction(() => {
          app.ctx.eventBus.recordEvent(proj.project_id, "agent-fail", "agent.joined", {
            agent_id: "agent-fail",
          });
          throw new Error("Simulated failure after event record");
        });
      }).toThrow("Simulated failure after event record");

      // No events should have been broadcast to subscribers
      expect(capturedEvents.length).toBe(0);

      // Execute committed transaction
      app.ctx.eventBus.transaction(() => {
        app.ctx.eventBus.recordEvent(proj.project_id, "agent-ok", "agent.joined", {
          agent_id: "agent-ok",
        });
      });

      // Exactly 1 event should have been broadcast
      expect(capturedEvents.length).toBe(1);

      unsubscribe();
    });
  });
});
