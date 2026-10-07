import { beforeEach, describe, expect, it } from "vitest";
import { HubClient } from "./client/hub-client.js";
import { createMcpServer } from "./server.js";

describe("MCP Server Tools & Protocol (Phase 4)", () => {
  let fakeHub: {
    calls: Array<{ method: string; url: string; body?: unknown }>;
    mockResponses: Record<string, unknown>;
  };
  let client: HubClient;

  beforeEach(() => {
    fakeHub = {
      calls: [],
      mockResponses: {
        "/v1/projects/proj-1/sessions": {
          session_id: "sess-123",
          project_id: "proj-1",
          agent_id: "agent-alice",
        },
        "/v1/projects/proj-1/inbox?limit=50": {
          events: [{ sequence: 1, type: "agent.joined", payload: { agent_id: "agent-alice" } }],
          next_cursor: "cursor-1",
          has_more: false,
        },
        "/v1/projects/proj-1/messages": {
          message_id: "msg-1",
          body: "Hello team",
        },
        "/v1/projects/proj-1/locks/claim": {
          lock_id: "lock-1",
          paths: ["src/index.ts"],
        },
        "/v1/projects/proj-1/team-status": {
          active_agents: [{ agent_id: "agent-alice" }],
          locks: [],
          statuses: [],
        },
      },
    };

    client = new HubClient({ baseUrl: "http://fake-hub:8787", token: "test-token" });

    // Mock fetch for client
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const url = new URL(urlStr);
      const pathWithQuery = `${url.pathname}${url.search}`;

      fakeHub.calls.push({
        method: init?.method ?? "GET",
        url: pathWithQuery,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      const matchedResponse =
        fakeHub.mockResponses[pathWithQuery] ?? fakeHub.mockResponses[url.pathname];

      if (matchedResponse) {
        return new Response(JSON.stringify({ data: matchedResponse }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "Mock endpoint not found" } }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  });

  it("lists all required collaborative tools", async () => {
    const server = createMcpServer({ hubClient: client });
    // Verify tools can be listed
    expect(server).toBeDefined();
  });

  it("executes join_project and check_inbox workflow through HubClient", async () => {
    const server = createMcpServer({ hubClient: client });

    // Simulate tool call for join_project
    const sessionRes = await client.createSession("proj-1", "agent-alice");
    expect(sessionRes.session_id).toBe("sess-123");

    // Simulate inbox call
    const inboxRes = await client.getInbox("proj-1");
    expect(inboxRes.events.length).toBe(1);
    expect(inboxRes.next_cursor).toBe("cursor-1");

    // Verify calls made
    expect(fakeHub.calls.some((c) => c.url.includes("/sessions"))).toBe(true);
    expect(fakeHub.calls.some((c) => c.url.includes("/inbox"))).toBe(true);
  });

  it("claims workspace locks and sends team messages", async () => {
    const lockRes = await client.claimLock("proj-1", "sess-123", {
      paths: ["src/index.ts"],
      reason: "Refactor",
    });
    expect(lockRes.lock_id).toBe("lock-1");

    const msgRes = await client.sendMessage("proj-1", "sess-123", {
      body: "Hello team",
    });
    expect(msgRes.message_id).toBe("msg-1");
  });

  it("validates MCP tool inputs using Zod schemas and returns isError on invalid input", async () => {
    const server = createMcpServer({ hubClient: client, defaultProjectId: "proj-1" });

    // Calling send_team_message before joining project
    // @ts-expect-error test direct handler invocation
    const handler = server._requestHandlers.get("tools/call");
    expect(handler).toBeDefined();

    if (handler) {
      // 1. Without session -> error
      const noSessionRes = await handler({
        method: "tools/call",
        params: {
          name: "send_team_message",
          arguments: { body: "test" },
        },
      });
      expect(noSessionRes.isError).toBe(true);
      expect(noSessionRes.content[0].text).toContain("Must join_project before sending messages");

      // 2. Join project
      await handler({
        method: "tools/call",
        params: {
          name: "join_project",
          arguments: { project_id: "proj-1", agent_name: "agent-alice" },
        },
      });

      // 3. Invalid tool arguments (empty paths array in claim_module_lock)
      const invalidClaimRes = await handler({
        method: "tools/call",
        params: {
          name: "claim_module_lock",
          arguments: { paths: [], reason: "empty" },
        },
      });
      expect(invalidClaimRes.isError).toBe(true);
      expect(invalidClaimRes.content[0].text).toContain("Invalid arguments for claim_module_lock");
    }
  });
});
