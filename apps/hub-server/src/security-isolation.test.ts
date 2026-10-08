import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("Security & Cross-Project Isolation (Phase 6 STRIDE Validation)", () => {
  it("strictly enforces multi-tenant isolation across all endpoints and session bindings", async () => {
    const app = buildApp({
      NODE_ENV: "production",
      CORS_ORIGINS: "http://localhost:5173",
      AUTH_TOKEN_TTL_SECONDS: 3600,
    });
    await app.listen({ port: 0 });
    const addr = app.server.address() as AddressInfo;

    const userA = "user-alice-isolated";
    const userB = "user-bob-isolated";

    const tokenA = app.ctx.authService.createToken(userA, "agents-hub");
    const tokenB = app.ctx.authService.createToken(userB, "agents-hub");

    // 1. Create two distinct projects owned by different users
    const projA = app.ctx.projectService.createProject("Project Alpha", userA).project;
    const projB = app.ctx.projectService.createProject("Project Beta", userB).project;

    // 2. Create sessions in respective projects
    const sessionA = app.ctx.sessionService.joinProject(projA.project_id, "agent-a", userA);
    const sessionB = app.ctx.sessionService.joinProject(projB.project_id, "agent-b", userB);

    try {
      // --- TEST 1: Cross-Project Session Join ---
      // User A (not a member of Project B) attempts to join Project B
      const joinCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projB.project_id}/sessions`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { agent_id: "intruder-agent" },
      });
      expect(joinCrossRes.statusCode).toBe(403);
      expect(joinCrossRes.json().error.code).toBe("FORBIDDEN");

      // --- TEST 2: Cross-Project Inbox Access ---
      // User A attempts to read inbox of Project B
      const inboxCrossRes = await app.inject({
        method: "GET",
        url: `/v1/projects/${projB.project_id}/inbox?session_id=${sessionB.session_id}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(inboxCrossRes.statusCode).toBe(403);
      expect(inboxCrossRes.json().error.code).toBe("FORBIDDEN");

      // --- TEST 3: Cross-Project Message Posting ---
      // User A attempts to send a message to Project B
      const msgCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projB.project_id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          session_id: sessionB.session_id,
          body: "Hello from unauthorized user",
        },
      });
      expect(msgCrossRes.statusCode).toBe(403);
      expect(msgCrossRes.json().error.code).toBe("FORBIDDEN");

      // User A attempts to send a message in Project A using sessionB (session hijacking)
      const msgHijackRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projA.project_id}/messages`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          session_id: sessionB.session_id,
          body: "Trying to use session from other project",
        },
      });
      expect(msgHijackRes.statusCode).toBe(403);
      expect(msgHijackRes.json().error.code).toBe("FORBIDDEN");

      // --- TEST 4: Cross-Project Workspace Locks ---
      // User A claims lock in Project A legitimately
      const lockRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projA.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          session_id: sessionA.session_id,
          paths: ["src/security.ts"],
          reason: "Legitimate lock in Alpha",
        },
      });
      expect(lockRes.statusCode).toBe(201);
      const lockA = lockRes.json().data;

      // User B attempts to claim lock in Project A
      const lockClaimCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projA.project_id}/locks/claim`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          session_id: sessionB.session_id,
          paths: ["src/security.ts"],
          reason: "Unauthorized lock claim in Alpha",
        },
      });
      expect(lockClaimCrossRes.statusCode).toBe(403);
      expect(lockClaimCrossRes.json().error.code).toBe("FORBIDDEN");

      // User B attempts to renew lock in Project A
      const lockRenewCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projA.project_id}/locks/${lockA.lock_id}/renew`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { session_id: sessionB.session_id, ttl_seconds: 600 },
      });
      expect(lockRenewCrossRes.statusCode).toBe(403);
      expect(lockRenewCrossRes.json().error.code).toBe("FORBIDDEN");

      // User B attempts to release lock in Project A
      const lockReleaseCrossRes = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projA.project_id}/locks/${lockA.lock_id}`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { session_id: sessionB.session_id },
      });
      expect(lockReleaseCrossRes.statusCode).toBe(403);
      expect(lockReleaseCrossRes.json().error.code).toBe("FORBIDDEN");

      // --- TEST 5: Cross-Project WebSocket Ticket Issuance & Hijacking ---
      // User B attempts to issue ticket for Project A
      const wsTicketCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projA.project_id}/ws-ticket`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { session_id: sessionA.session_id },
      });
      expect(wsTicketCrossRes.statusCode).toBe(403);
      expect(wsTicketCrossRes.json().error.code).toBe("FORBIDDEN");

      // User A issues a valid ticket for Project A
      const validTicketRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projA.project_id}/ws-ticket`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { session_id: sessionA.session_id },
      });
      expect(validTicketRes.statusCode).toBe(201);
      const { ticket: ticketA } = validTicketRes.json().data;

      // Attempt to connect to Project B WebSocket using ticket issued for Project A
      const crossWs = new globalThis.WebSocket(
        `ws://127.0.0.1:${addr.port}/v1/projects/${projB.project_id}/events?ticket=${ticketA}&session_id=${sessionA.session_id}`,
        { headers: { Origin: "http://localhost:5173" } },
      );

      const crossWsCode = await new Promise<number>((resolve) => {
        const timeout = setTimeout(() => resolve(-1), 3000);
        crossWs.onclose = (e) => {
          clearTimeout(timeout);
          resolve(e.code);
        };
      });
      // Socket must be closed with 1008 Unauthorized / Policy Violation
      expect(crossWsCode).toBe(1008);

      // --- TEST 6: Cross-Project Status Report ---
      const statusCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projB.project_id}/status`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          session_id: sessionB.session_id,
          objective: "Cross project status attempt",
          progress: "in_progress",
        },
      });
      expect(statusCrossRes.statusCode).toBe(403);
      expect(statusCrossRes.json().error.code).toBe("FORBIDDEN");

      // --- TEST 7: Cross-Project Cursor ACK ---
      const ackCrossRes = await app.inject({
        method: "POST",
        url: `/v1/projects/${projB.project_id}/inbox/ack`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          session_id: sessionB.session_id,
          cursor: "MQ",
        },
      });
      expect(ackCrossRes.statusCode).toBe(403);
      expect(ackCrossRes.json().error.code).toBe("FORBIDDEN");
    } finally {
      await app.close();
    }
  });
});
