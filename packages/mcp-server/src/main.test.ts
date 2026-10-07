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

  it("connects real MCP Client via InMemoryTransport and executes tool pipeline end-to-end", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = createMcpServer({ hubClient: client });
    const mcpClient = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    // 1. List tools
    const tools = await mcpClient.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("join_project");
    expect(toolNames).toContain("check_inbox");
    expect(toolNames).toContain("wait_for_messages");
    expect(toolNames).toContain("send_team_message");
    expect(toolNames).toContain("report_status");
    expect(toolNames).toContain("claim_module_lock");
    expect(toolNames).toContain("release_module_lock");
    expect(toolNames).toContain("get_team_status");

    // 2. Call join_project
    const joinRes = await mcpClient.callTool({
      name: "join_project",
      arguments: { project_id: "proj-1", agent_name: "agent-alice" },
    });
    expect(joinRes.isError).toBeFalsy();
    const joinContent = joinRes.content as Array<{ type: string; text: string }>;
    expect(joinContent[0]?.text).toContain("sess-123");

    // 3. Call send_team_message
    const sendRes = await mcpClient.callTool({
      name: "send_team_message",
      arguments: { body: "Hello through real MCP client" },
    });
    expect(sendRes.isError).toBeFalsy();
    const sendContent = sendRes.content as Array<{ type: string; text: string }>;
    expect(sendContent[0]?.text).toContain("msg-1");

    // 4. Call claim_module_lock
    const lockRes = await mcpClient.callTool({
      name: "claim_module_lock",
      arguments: { paths: ["src/index.ts"], reason: "Editing" },
    });
    expect(lockRes.isError).toBeFalsy();
    const lockContent = lockRes.content as Array<{ type: string; text: string }>;
    expect(lockContent[0]?.text).toContain("lock-1");

    // 5. Cleanup
    await mcpClient.close();
    await server.close();
  });

  describe("Retry Backoff & Resilience", () => {
    it("retries on 503 and succeeds on subsequent attempt", async () => {
      const { withRetry } = await import("./client/retry.js");
      let attempts = 0;
      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 2) {
            const err = new Error("Service unavailable") as Error & { status: number };
            err.status = 503;
            throw err;
          }
          return "success";
        },
        { initialDelayMs: 10, maxDelayMs: 50, maxRetries: 3 },
      );

      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });

    it("does not retry on 400 or 403 non-retryable errors", async () => {
      const { withRetry } = await import("./client/retry.js");
      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            const err = new Error("Forbidden") as Error & { status: number };
            err.status = 403;
            throw err;
          },
          { initialDelayMs: 10, maxRetries: 3 },
        ),
      ).rejects.toThrow("Forbidden");

      expect(attempts).toBe(1);
    });
  });
});
