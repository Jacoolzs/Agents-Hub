import { setTimeout as sleep } from "node:timers/promises";
import {
  AckInboxInputSchema,
  CheckInboxInputSchema,
  ClaimLockInputSchema,
  EmptyInputSchema,
  IdempotencyKeySchema,
  InboxResponseSchema,
  JoinProjectInputSchema,
  MessageSchema,
  ReleaseLockInputSchema,
  ReportStatusInputSchema,
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

export interface McpServerContext {
  hubClient: HubClient;
  defaultProjectId?: string | undefined;
  defaultAgentName?: string | undefined;
}
const string = { type: "string" } as const;
const key = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  description: "Reuse this key only to retry the same command",
} as const;
const tools = [
  {
    name: "join_project",
    description:
      "Join before project tools. Returns persisted confirmed cursor and collaboration rules.",
    properties: {
      project_id: string,
      agent_name: string,
      capabilities: { type: "array", items: string },
    },
    required: ["project_id", "agent_name"],
  },
  {
    name: "check_inbox",
    description:
      "Read visible events. Passing the cursor from a previously consumed page confirms that page before reading the next. Omit cursor to replay from confirmed checkpoint.",
    properties: { cursor: string, limit: { type: "integer", minimum: 1, maximum: 100 } },
    required: [],
  },
  {
    name: "ack_inbox",
    description: "Confirm a page only AFTER consuming its events; use its next_cursor.",
    properties: { cursor: string },
    required: ["cursor"],
  },
  {
    name: "wait_for_messages",
    description:
      "Wait during an active session, cancellable and limited to 60 seconds. Same cursor confirmation contract as check_inbox.",
    properties: { cursor: string, timeout_seconds: { type: "integer", minimum: 1, maximum: 60 } },
    required: [],
  },
  {
    name: "send_team_message",
    description: "Send structured coordination, without credentials or private reasoning.",
    properties: {
      body: { type: "string", minLength: 1, maxLength: 4096 },
      channel: string,
      recipient_agent_ids: { type: "array", items: string },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      correlation_id: string,
      idempotency_key: key,
    },
    required: ["body"],
  },
  {
    name: "report_status",
    description: "Publish objective, progress, decision and blockers as a human summary.",
    properties: {
      objective: string,
      progress: { type: "string", enum: ["started", "in_progress", "blocked", "completed"] },
      decision: string,
      blocked_by: string,
      next_step: string,
      idempotency_key: key,
    },
    required: ["objective"],
  },
  {
    name: "claim_module_lock",
    description:
      "Claim relative paths with TTL. Key is generated once per call if omitted for compatibility; pass a stable key to retry a tool call.",
    properties: {
      paths: { type: "array", items: string },
      reason: string,
      ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
      idempotency_key: key,
    },
    required: ["paths", "reason"],
  },
  {
    name: "release_module_lock",
    description: "Release a lock by lock_id. Legacy paths are accepted for existing clients.",
    properties: { lock_id: string, paths: { type: "array", items: string } },
    required: [],
  },
  {
    name: "get_team_status",
    description: "Read agents, status and active locks after joining.",
    properties: {},
    required: [],
  },
];

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Tool execution failed";
  return text
    .replace(/\b(?:ah_|ahi_|wst_|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
function content(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createMcpServer(ctx: McpServerContext): Server & { shutdown(): Promise<void> } {
  const server = new Server(
    { name: "agents-hub-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  ) as Server & { shutdown(): Promise<void> };
  let joined: { projectId: string; agentId: string; sessionId: string } | undefined;
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
        const session = await ctx.hubClient.createSession(input.project_id, input.agent_name);
        if (
          typeof session.session_id !== "string" ||
          session.project_id !== input.project_id ||
          session.agent_id !== input.agent_name
        )
          throw new Error("Invalid session response from Hub");
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
      const acknowledge = async (cursor?: string) => {
        if (cursor) {
          if (decodeCursor(cursor) === null) throw new Error("Invalid cursor");
          const ack = await ctx.hubClient.ackInbox(room.projectId, room.sessionId, cursor);
          confirmed = ack.cursor;
        }
      };
      const read = async (cursor: string, limit: number, readSignal: AbortSignal) =>
        InboxResponseSchema.parse(
          await ctx.hubClient.getInbox(room.projectId, room.sessionId, cursor, limit, readSignal),
        );
      switch (name) {
        case "ack_inbox": {
          const input = AckInboxInputSchema.parse(args);
          await acknowledge(input.cursor);
          return content({ cursor: confirmed, status: "confirmed" });
        }
        case "check_inbox": {
          const input = CheckInboxInputSchema.parse(args);
          await acknowledge(input.cursor);
          return content(await read(confirmed, input.limit, signal));
        }
        case "wait_for_messages": {
          const input = WaitForMessagesInputSchema.parse(args);
          await acknowledge(input.cursor);
          const start = Date.now();
          const waitSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(input.timeout_seconds * 1000),
          ]);
          try {
            while (!waitSignal.aborted) {
              const inbox = await read(confirmed, 50, waitSignal);
              if (inbox.events.length)
                return content({
                  ...inbox,
                  cursor: inbox.next_cursor,
                  waited_ms: Date.now() - start,
                });
              await sleep(Math.min(1000, input.timeout_seconds * 1000), undefined, {
                signal: waitSignal,
              });
            }
          } catch (error) {
            if (!waitSignal.aborted || signal.aborted) throw error;
          }
          signal.throwIfAborted();
          return content({
            events: [],
            cursor: confirmed,
            next_cursor: confirmed,
            has_more: false,
            waited_ms: Date.now() - start,
          });
        }
        case "send_team_message": {
          const { idempotency_key, ...payload } = args;
          const input = SendMessageInputSchema.parse(payload);
          if (input.body.length > 4096 || containsObviousSecret(input.body))
            throw new Error("Message must contain at most 4096 characters and no credentials");
          const id = IdempotencyKeySchema.parse(idempotency_key ?? crypto.randomUUID());
          return content(
            MessageSchema.parse(
              await ctx.hubClient.sendMessage(room.projectId, room.sessionId, input, id),
            ),
          );
        }
        case "report_status": {
          const { idempotency_key, ...payload } = args;
          return content(
            StatusReportSchema.parse(
              await ctx.hubClient.reportStatus(
                room.projectId,
                room.sessionId,
                ReportStatusInputSchema.parse(payload),
                IdempotencyKeySchema.parse(idempotency_key ?? crypto.randomUUID()),
              ),
            ),
          );
        }
        case "claim_module_lock": {
          const { idempotency_key, ...payload } = args;
          return content(
            WorkspaceLockSchema.parse(
              await ctx.hubClient.claimLock(
                room.projectId,
                room.sessionId,
                ClaimLockInputSchema.parse(payload),
                IdempotencyKeySchema.parse(idempotency_key ?? crypto.randomUUID()),
              ),
            ),
          );
        }
        case "release_module_lock": {
          if (args.lock_id !== undefined) {
            if (
              !UuidSchema.safeParse(args.lock_id).success ||
              Object.keys(args).some((k) => k !== "lock_id")
            )
              throw new Error("Invalid lock_id");
            return content(
              await ctx.hubClient.releaseLockById(
                room.projectId,
                room.sessionId,
                UuidSchema.parse(args.lock_id),
              ),
            );
          }
          const input = ReleaseLockInputSchema.parse(args);
          return content(
            await ctx.hubClient.releaseLock(room.projectId, room.sessionId, input.paths),
          );
        }
        case "get_team_status":
          EmptyInputSchema.parse(args);
          return content(await ctx.hubClient.getTeamStatus(room.projectId));
        default:
          throw new Error("Unknown tool");
      }
    } catch (error) {
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
