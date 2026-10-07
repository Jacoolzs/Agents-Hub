import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { type AppContext, buildApp } from "./app.js";
import { createDatabase } from "./infrastructure/db/database.js";

describe("Hub Server Network & API (Phase 3)", () => {
  let app: FastifyInstance & { ctx: AppContext };
  let authToken: string;
  let testUserId: string;

  beforeEach(() => {
    const db = createDatabase(":memory:");
    app = buildApp({}, db);
    testUserId = "user-alice";
    authToken = app.ctx.authService.createToken(testUserId, "agents-hub");
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
  });
});
