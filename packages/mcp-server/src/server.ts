import { setTimeout as sleep } from "node:timers/promises";
import {
  AckInboxInputSchema,
  CheckInboxInputSchema,
  ClaimLockInputSchema,
  EmptyInputSchema,
  IdempotencyKeySchema,
  InboxRecoverySchema,
  InboxResponseSchema,
  JoinProjectInputSchema,
  MessageSchema,
  ReleaseLockInputSchema,
  ReportStatusInputSchema,
  ResyncInboxInputSchema,
  SendMessageInputSchema,
  StatusReportSchema,
  UuidSchema,
  WaitForMessagesInputSchema,
  WorkspaceLockSchema,
  containsObviousSecret,
  decodeCursor,
  encodeCursor,
} from "@agents-hub/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HubClient } from "./client/hub-client.js";
import { tools } from "./tools/catalog.js";
import { executeProjectCommand } from "./tools/commands.js";
import { executeInboxTool } from "./tools/inbox.js";
import { content, safeError } from "./tools/response.js";

export interface McpServerContext {
  hubClient: HubClient;
  defaultProjectId?: string | undefined;
  defaultAgentName?: string | undefined;
}

export function createMcpServer(ctx: McpServerContext): Server & { shutdown(): Promise<void> } {
  const server = new Server(
    { name: "agents-hub-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  ) as Server & { shutdown(): Promise<void> };
  let joined: { projectId: string; agentId: string; sessionId: string } | undefined;
  const instanceId = crypto.randomUUID();
  let confirmed = encodeCursor(0);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const lifecycle = new AbortController();
  let stopped = false;

  server.shutdown = async () => {
    if (stopped) return;
    stopped = true;
    lifecycle.abort();
    clearInterval(heartbeat);
    if (joined)
      await ctx.hubClient
        .disconnect(joined.sessionId, joined.projectId, joined.agentId)
        .catch(() => {});
  };
  server.onclose = () => {
    void server.shutdown();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object" as const,
        properties: t.properties,
        required: t.required,
        additionalProperties: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: raw = {} } = req.params;
    try {
      const args = raw as Record<string, unknown>;
      if (name === "join_project") {
        const input = JoinProjectInputSchema.parse({
          project_id: ctx.defaultProjectId,
          agent_name: ctx.defaultAgentName,
          ...args,
        });
        // Commit local identity only after the Hub authorizes and creates the session.
        const session = await ctx.hubClient.createSession(
          input.project_id,
          input.agent_name,
          instanceId,
        );
        if (
          typeof session.session_id !== "string" ||
          session.project_id !== input.project_id ||
          session.agent_id !== input.agent_name
        )
          throw new Error("Invalid session response from Hub");
        if (stopped || extra?.signal?.aborted) {
          if (joined?.sessionId !== session.session_id)
            await ctx.hubClient
              .disconnect(session.session_id, session.project_id, session.agent_id)
              .catch(() => {});
          throw new Error("Join cancelled while the adapter was closing");
        }
        if (joined && joined.sessionId !== session.session_id)
          await ctx.hubClient
            .disconnect(joined.sessionId, joined.projectId, joined.agentId)
            .catch(() => {});
        joined = {
          projectId: session.project_id,
          agentId: session.agent_id,
          sessionId: session.session_id,
        };
        confirmed = session.last_cursor ?? encodeCursor(0);
        if (decodeCursor(confirmed) === null) throw new Error("Invalid session cursor from Hub");
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (joined)
            void ctx.hubClient
              .heartbeat(joined.sessionId, joined.projectId, joined.agentId)
              .catch(() => {});
        }, 30000);
        heartbeat.unref();
        return content({
          status: "connected",
          session_id: session.session_id,
          project_id: session.project_id,
          agent_id: session.agent_id,
          cursor: confirmed,
          rules: [
            "Check inbox before and after significant work.",
            "Confirm next_cursor only after consuming the page, via check_inbox(cursor) or ack_inbox.",
            "Share summaries, never credentials or private reasoning.",
            "Locks coordinate intent; inactive agents do not wake automatically (ADR-006).",
          ],
        });
      }
      if (!joined)
        throw new Error(
          `Must join_project before ${name === "send_team_message" ? "sending messages" : name}`,
        );
      const room = joined;
      const signal = AbortSignal.any([
        extra?.signal ?? new AbortController().signal,
        lifecycle.signal,
      ]);
      const runtime = {
        hubClient: ctx.hubClient,
        room,
        signal,
        getConfirmed: () => confirmed,
        setConfirmed: (cursor: string) => {
          confirmed = cursor;
        },
      };
      const inboxResult = await executeInboxTool(name, args, runtime);
      return inboxResult ?? (await executeProjectCommand(name, args, runtime));
    } catch (error) {
      const apiError = error as { code?: string; details?: Record<string, unknown> } | null;
      if (apiError?.code === "CURSOR_EXPIRED")
        return {
          isError: true,
          ...content({
            code: "CURSOR_EXPIRED",
            message: safeError(error),
            resume_cursor: apiError.details?.resume_cursor,
            next_step:
              "Call get_inbox_recovery; review snapshot, then resync_inbox only if you explicitly accept lost history.",
          }),
        };
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Tool Execution Error: ${safeError(error)}` }],
      };
    }
  });
  return server;
}

export async function runServer(): Promise<void> {
  const url = process.env.AGENTS_HUB_URL || "http://127.0.0.1:8787";
  const parsed = new URL(url);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      ))
  )
    throw new Error("Use HTTPS for a remote Hub");
  const token = process.env.AGENTS_HUB_TOKEN || "";
  if (!token) throw new Error("AGENTS_HUB_TOKEN is required");
  const server = createMcpServer({
    hubClient: new HubClient({ baseUrl: url, token }),
    defaultProjectId: process.env.AGENTS_HUB_PROJECT_ID,
    defaultAgentName: process.env.AGENTS_HUB_AGENT_NAME,
  });
  const stop = async () => {
    await server.shutdown();
    await server.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.stdin.once("end", () => void stop());
  await server.connect(new StdioServerTransport());
  console.error("Agents-Hub MCP Server running via stdio");
}
