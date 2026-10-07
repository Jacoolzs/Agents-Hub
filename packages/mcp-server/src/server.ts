import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HubClient } from "./client/hub-client.js";

export interface McpServerContext {
  hubClient: HubClient;
  defaultProjectId?: string | undefined;
  defaultAgentName?: string | undefined;
}

export function createMcpServer(ctx: McpServerContext): Server {
  const server = new Server(
    {
      name: "agents-hub-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  let currentProjectId = ctx.defaultProjectId;
  let currentAgentId = ctx.defaultAgentName;
  let currentSessionId: string | undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "join_project",
          description:
            "Connect to an Agents-Hub project room before performing collaborative actions",
          inputSchema: {
            type: "object",
            properties: {
              project_id: { type: "string", description: "Project UUID" },
              agent_name: { type: "string", description: "Agent identifier or name" },
            },
            required: ["project_id", "agent_name"],
          },
        },
        {
          name: "check_inbox",
          description:
            "Check for new messages, state changes, and team events from colleagues using a sequence cursor",
          inputSchema: {
            type: "object",
            properties: {
              cursor: { type: "string", description: "Optional cursor from previous check_inbox" },
              limit: { type: "number", description: "Max events to fetch (1-100)" },
            },
          },
        },
        {
          name: "wait_for_messages",
          description: "Wait up to N seconds for incoming team messages or project events",
          inputSchema: {
            type: "object",
            properties: {
              cursor: { type: "string", description: "Optional cursor to resume from" },
              timeout_seconds: { type: "number", description: "Wait duration in seconds (1-60)" },
            },
          },
        },
        {
          name: "send_team_message",
          description: "Send a targeted or broadcast message to other agents/humans in the room",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string", description: "Message content" },
              channel: { type: "string", description: "Channel name (default: general)" },
              recipient_agent_ids: {
                type: "array",
                items: { type: "string" },
                description: "Specific target agents (leave empty for broadcast)",
              },
              priority: {
                type: "string",
                enum: ["low", "normal", "high", "urgent"],
              },
              correlation_id: { type: "string", description: "Optional reply correlation ID" },
            },
            required: ["body"],
          },
        },
        {
          name: "report_status",
          description: "Publish your current objective, progress, technical decisions and blockers",
          inputSchema: {
            type: "object",
            properties: {
              objective: { type: "string", description: "What you are currently working on" },
              progress: {
                type: "string",
                enum: ["started", "in_progress", "blocked", "completed"],
              },
              decision: { type: "string", description: "Technical decisions made" },
              blocked_by: { type: "string", description: "Blocker details if blocked" },
              next_step: { type: "string", description: "Next planned step" },
            },
            required: ["objective"],
          },
        },
        {
          name: "claim_module_lock",
          description:
            "Lock one or more relative file/directory paths to prevent code collision with teammates",
          inputSchema: {
            type: "object",
            properties: {
              paths: {
                type: "array",
                items: { type: "string" },
                description: "Array of workspace paths (e.g. ['src/api/auth.ts'])",
              },
              reason: { type: "string", description: "Why you need to edit these files" },
              ttl_seconds: {
                type: "number",
                description: "Lock duration in seconds (default 300)",
              },
            },
            required: ["paths", "reason"],
          },
        },
        {
          name: "release_module_lock",
          description: "Release previously claimed workspace paths after finishing work",
          inputSchema: {
            type: "object",
            properties: {
              paths: {
                type: "array",
                items: { type: "string" },
                description: "Paths to release",
              },
            },
            required: ["paths"],
          },
        },
        {
          name: "get_team_status",
          description:
            "View all active agents, their current objectives, and active workspace locks",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    try {
      switch (name) {
        case "join_project": {
          const { project_id, agent_name } = args as { project_id: string; agent_name: string };
          currentProjectId = project_id;
          currentAgentId = agent_name;
          const session = await ctx.hubClient.createSession(project_id, agent_name);
          currentSessionId = session.session_id;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "connected",
                    session_id: session.session_id,
                    project_id,
                    agent_id: agent_name,
                    message: `Joined project ${project_id} as ${agent_name}`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "check_inbox": {
          if (!currentProjectId) throw new Error("Must join_project before check_inbox");
          const { cursor, limit = 50 } = args as { cursor?: string; limit?: number };
          const inbox = await ctx.hubClient.getInbox(currentProjectId, cursor, limit);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(inbox, null, 2),
              },
            ],
          };
        }

        case "wait_for_messages": {
          if (!currentProjectId) throw new Error("Must join_project before wait_for_messages");
          const { cursor, timeout_seconds = 10 } = args as {
            cursor?: string;
            timeout_seconds?: number;
          };
          const maxWaitMs = Math.min(Math.max(timeout_seconds * 1000, 1000), 60000);
          const start = Date.now();

          let latestCursor = cursor;
          let eventsFound: unknown[] = [];

          while (Date.now() - start < maxWaitMs) {
            const inbox = await ctx.hubClient.getInbox(currentProjectId, latestCursor, 10);
            if (inbox.events.length > 0) {
              eventsFound = inbox.events;
              latestCursor = inbox.next_cursor;
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    events: eventsFound,
                    cursor: latestCursor,
                    waited_ms: Date.now() - start,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "send_team_message": {
          if (!currentProjectId || !currentAgentId) {
            throw new Error("Must join_project before sending messages");
          }
          const { body, channel, recipient_agent_ids, priority, correlation_id } = args as {
            body: string;
            channel?: string;
            recipient_agent_ids?: string[];
            priority?: string;
            correlation_id?: string;
          };

          const result = await ctx.hubClient.sendMessage(currentProjectId, currentAgentId, {
            body,
            channel,
            recipient_agent_ids,
            priority,
            correlation_id,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "report_status": {
          if (!currentProjectId || !currentAgentId) {
            throw new Error("Must join_project before reporting status");
          }
          const statusArgs = args as {
            objective: string;
            progress?: string;
            decision?: string;
            blocked_by?: string;
            next_step?: string;
          };

          const result = await ctx.hubClient.reportStatus(
            currentProjectId,
            currentAgentId,
            statusArgs,
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "claim_module_lock": {
          if (!currentProjectId || !currentAgentId) {
            throw new Error("Must join_project before claiming locks");
          }
          const { paths, reason, ttl_seconds } = args as {
            paths: string[];
            reason: string;
            ttl_seconds?: number;
          };

          const result = await ctx.hubClient.claimLock(currentProjectId, currentAgentId, {
            paths,
            reason,
            ttl_seconds,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "release_module_lock": {
          if (!currentProjectId || !currentAgentId) {
            throw new Error("Must join_project before releasing locks");
          }
          const { paths } = args as { paths: string[] };
          const result = await ctx.hubClient.releaseLock(currentProjectId, currentAgentId, paths);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_team_status": {
          if (!currentProjectId) {
            throw new Error("Must join_project before getting team status");
          }
          const result = await ctx.hubClient.getTeamStatus(currentProjectId);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool Execution Error: ${errMsg}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function runServer(): Promise<void> {
  const url = process.env.AGENTS_HUB_URL || "http://127.0.0.1:8787";
  const token = process.env.AGENTS_HUB_TOKEN || "";
  const projectId = process.env.AGENTS_HUB_PROJECT_ID;
  const agentName = process.env.AGENTS_HUB_AGENT_NAME;

  const client = new HubClient({ baseUrl: url, token });
  const server = createMcpServer({
    hubClient: client,
    defaultProjectId: projectId,
    defaultAgentName: agentName,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agents-Hub MCP Server running via stdio");
}
