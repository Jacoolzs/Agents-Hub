import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildApp } from "../apps/hub-server/src/app.js";

const sdk = createRequire(path.resolve("packages/mcp-server/package.json"));
const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdk("@modelcontextprotocol/sdk/client/stdio.js");
const { ResourceUpdatedNotificationSchema } = sdk("@modelcontextprotocol/sdk/types.js");

test("proceso MCP stdio recibe avisos sin comandos de escucha ni ACK automático", async () => {
  const base = "http://127.0.0.1:8827";
  const hub = buildApp({ NODE_ENV: "production", CORS_ORIGINS: base });
  const client = new Client({ name: "listener-stdio", version: "1.0.0" }, { capabilities: {} });
  const uri = "agents-hub://inbox";
  const notices: unknown[] = [];
  let reads = 0;
  let acks = 0;
  hub.addHook("onRequest", async (req) => {
    if (req.url.includes("/inbox?") && req.method === "GET") reads++;
    if (req.url.endsWith("/inbox/ack")) acks++;
  });
  client.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    (notice: { params: unknown }) => {
      notices.push(notice.params);
    },
  );
  try {
    const user = crypto.randomUUID();
    const token = hub.ctx.authService.createToken(user, "agents-hub");
    const project = hub.ctx.projectService.createProject("Listener stdio", user).project.project_id;
    await hub.listen({ host: "127.0.0.1", port: 8827 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].startsWith("AGENTS_HUB_"),
      ),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("packages/mcp-server/dist/main.js")],
        env: {
          ...env,
          NODE_ENV: "production",
          AGENTS_HUB_URL: base,
          AGENTS_HUB_TOKEN: token,
          AGENTS_HUB_PROJECT_ID: project,
          AGENTS_HUB_AGENT_NAME: "stdio-listener",
        },
        stderr: "pipe",
      }),
    );
    expect((await client.listResources()).resources[0].uri).toBe(uri);
    await client.subscribeResource({ uri });
    expect((await client.callTool({ name: "join_project", arguments: {} })).isError).not.toBe(true);
    await expect.poll(() => notices.length).toBeGreaterThan(0);
    expect(notices[0]).toEqual({ uri });
    expect(reads).toBe(0);
    const previous = notices.length;
    hub.ctx.messageService.sendMessage(project, "fixture-sender", {
      body: "Un aviso mientras la IA no hace llamadas",
      channel: "general",
      recipient_agent_ids: ["stdio-listener"],
    });
    await expect.poll(() => notices.length).toBeGreaterThan(previous);
    expect(reads).toBe(0);
    const result = await client.readResource({ uri });
    expect(result.contents[0].text).toContain("Un aviso mientras la IA no hace llamadas");
    expect(await client.readResource({ uri })).toEqual(result);
    expect(reads).toBe(2);
    expect(acks).toBe(0);
    expect(JSON.stringify(notices)).not.toContain(token);
  } finally {
    await client.close();
    await expect.poll(() => hub.ctx.wsHub.getSubscriberCount()).toBe(0);
    await hub.close();
    hub.ctx.db.close();
  }
});
