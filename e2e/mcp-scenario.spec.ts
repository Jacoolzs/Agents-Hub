import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildApp } from "../apps/hub-server/src/app.js";

// Reuse the adapter's installed SDK; no extra SDK copy in the root workspace.
const sdkRequire = createRequire(path.resolve("packages/mcp-server/package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdkRequire("@modelcontextprotocol/sdk/client/stdio.js");

test("dos procesos MCP: estado, conflicto, mensaje dirigido, replay y expiración", async () => {
  const hub = buildApp();
  const clients: Array<{ close(): Promise<void> }> = [];
  await hub.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
  const owner = crypto.randomUUID();
  const teammate = crypto.randomUUID();
  const token = hub.ctx.authService.createToken(owner, "agents-hub");
  const project = hub.ctx.projectService.createProject("MVP scenario", owner).project;
  hub.ctx.db
    .prepare("INSERT INTO users VALUES (?, ?, ?)")
    .run(teammate, "bob", new Date().toISOString());
  const invitation = hub.ctx.membershipService.createInvitation(
    owner,
    project.project_id,
    { role: "collaborator" },
    crypto.randomUUID(),
  );
  hub.ctx.membershipService.acceptInvitation(
    teammate,
    project.project_id,
    invitation.token,
    crypto.randomUUID(),
  );
  const teammateToken = hub.ctx.authService.createToken(teammate, "agents-hub");

  async function spawnAgent(name: string, personalToken = token) {
    const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("packages/mcp-server/dist/main.js")],
      env: {
        ...env,
        NODE_ENV: "production",
        AGENTS_HUB_URL: baseUrl,
        AGENTS_HUB_TOKEN: personalToken,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    return client;
  }

  async function call(client: InstanceType<typeof Client>, name: string, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return JSON.parse(result.content[0].text);
  }

  try {
    let alice = await spawnAgent("alice-client");
    const bob = await spawnAgent("bob-client", teammateToken);
    const join = { project_id: project.project_id };
    const a = await call(alice, "join_project", { ...join, agent_name: "alice" });
    const competing = await spawnAgent("competing-alice");
    const duplicate = await competing.callTool({
      name: "join_project",
      arguments: { ...join, agent_name: "alice" },
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toContain("STATE_CONFLICT");
    await competing.close();
    expect((await call(alice, "join_project", { ...join, agent_name: "alice" })).session_id).toBe(
      a.session_id,
    );
    expect(
      hub.ctx.eventBus
        .getEventsAfter(project.project_id)
        .filter((event) => event.type === "agent.joined"),
    ).toHaveLength(1);
    await call(alice, "report_status", { objective: "Implementar auth", progress: "started" });
    await call(bob, "join_project", { ...join, agent_name: "bob" });
    const status = await call(bob, "get_team_status");
    expect(status.active_agents.map((agent: { agent_id: string }) => agent.agent_id)).toContain(
      "alice",
    );
    await call(alice, "claim_module_lock", { paths: ["src/auth"], reason: "MVP", ttl_seconds: 1 });
    const conflict = await bob.callTool({
      name: "claim_module_lock",
      arguments: { paths: ["src/auth/x.ts"], reason: "Conflict" },
    });
    expect(conflict.isError).toBe(true);
    await call(alice, "send_team_message", {
      body: "Contrato para Bob",
      recipient_agent_ids: ["bob"],
    });
    const inbox = await call(bob, "check_inbox");
    expect(JSON.stringify(inbox)).toContain("Contrato para Bob");
    await call(bob, "send_team_message", {
      body: "Contrato recibido",
      recipient_agent_ids: ["alice"],
    });
    const beforeRestart = await call(alice, "send_team_message", {
      body: "Comando antes de reiniciar",
      idempotency_key: "across-generation",
    });
    const checkpoint = await call(alice, "check_inbox");
    await call(alice, "ack_inbox", { cursor: checkpoint.next_cursor });
    await alice.close();
    await expect
      .poll(() => hub.ctx.sessionService.getSessionById(a.session_id).status)
      .toBe("disconnected");
    await call(bob, "send_team_message", {
      body: "Mensaje durante desconexión",
      recipient_agent_ids: ["alice"],
    });
    alice = await spawnAgent("alice-reconnected");
    const resumed = await call(alice, "join_project", { ...join, agent_name: "alice" });
    expect(resumed.session_id).not.toBe(a.session_id);
    const staleDisconnect = await hub.inject({
      method: "DELETE",
      url: `/v1/sessions/${a.session_id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.project_id, agent_id: "alice" },
    });
    expect(staleDisconnect.statusCode).toBe(401);
    expect(resumed.cursor).toBe(checkpoint.next_cursor);
    expect(
      await call(alice, "send_team_message", {
        body: "Comando antes de reiniciar",
        idempotency_key: "across-generation",
      }),
    ).toEqual(beforeRestart);
    const replay = await call(alice, "check_inbox");
    expect(JSON.stringify(replay)).toContain("Mensaje durante desconexión");
    expect(JSON.stringify(replay)).not.toContain("Contrato recibido");
    await call(alice, "check_inbox", { cursor: replay.next_cursor });
    const sent = await call(alice, "send_team_message", {
      body: "Idempotent command",
      idempotency_key: "mcp-retry",
    });
    expect(
      await call(alice, "send_team_message", {
        body: "Idempotent command",
        idempotency_key: "mcp-retry",
      }),
    ).toEqual(sent);
    const consumed = await call(alice, "check_inbox");
    await call(alice, "ack_inbox", { cursor: consumed.next_cursor });
    const cancelled = new AbortController();
    const waiting = alice.callTool(
      { name: "wait_for_messages", arguments: { timeout_seconds: 60 } },
      undefined,
      { signal: cancelled.signal },
    );
    setTimeout(() => cancelled.abort(), 100);
    await expect(waiting).rejects.toThrow();
    const bounded = await call(alice, "wait_for_messages", { timeout_seconds: 1 });
    expect(bounded.events).toEqual([]);
    expect(bounded.waited_ms).toBeLessThan(2500);
    await expect.poll(() => hub.ctx.lockService.getActiveLocks(project.project_id).length).toBe(0);
    await call(bob, "claim_module_lock", { paths: ["src/auth"], reason: "TTL expired" });
    const beforeGap = hub.ctx.sessionService.getSessionById(resumed.session_id).last_cursor;
    hub.ctx.eventBus.pruneEventsBefore("9999-01-01T00:00:00.000Z");
    const expired = await alice.callTool({ name: "check_inbox", arguments: {} });
    expect(expired.isError).toBe(true);
    expect(JSON.parse(expired.content[0].text).code).toBe("CURSOR_EXPIRED");
    const recovery = await call(alice, "get_inbox_recovery");
    expect(recovery.snapshot.locks[0].owner_agent_id).toBe("bob");
    expect(hub.ctx.sessionService.getSessionById(resumed.session_id).last_cursor).toBe(beforeGap);
    await call(bob, "send_team_message", {
      body: "Conservado tras retención",
      recipient_agent_ids: ["alice"],
    });
    const rejectedAcceptance = await alice.callTool({
      name: "resync_inbox",
      arguments: { cursor: recovery.resume_cursor, accept_history_gap: false },
    });
    expect(rejectedAcceptance.isError).toBe(true);
    expect(hub.ctx.sessionService.getSessionById(resumed.session_id).last_cursor).toBe(beforeGap);
    const retained = await call(alice, "resync_inbox", {
      cursor: recovery.resume_cursor,
      accept_history_gap: true,
    });
    expect(JSON.stringify(retained.events)).toContain("Conservado tras retención");
    expect(hub.ctx.sessionService.getSessionById(resumed.session_id).last_cursor).toBe(
      recovery.resume_cursor,
    );
    await call(alice, "ack_inbox", { cursor: retained.next_cursor });
    const outsiderToken = hub.ctx.authService.createToken("outsider", "agents-hub");
    const denied = await hub.inject({
      method: "GET",
      url: `/v1/projects/${project.project_id}/team-status`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(denied.statusCode).toBe(403);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await hub.close();
    hub.ctx.db.close();
  }
});
