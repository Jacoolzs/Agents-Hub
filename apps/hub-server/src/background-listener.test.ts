import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { HubClient } from "../../../packages/mcp-server/src/client/hub-client.js";
import { createMcpServer } from "../../../packages/mcp-server/src/server.js";
import { buildApp } from "./app.js";

const sdk = createRequire(path.resolve("packages/mcp-server/package.json"));
const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = sdk("@modelcontextprotocol/sdk/inMemory.js");
const { ResourceUpdatedNotificationSchema } = sdk("@modelcontextprotocol/sdk/types.js");
const uri = "agents-hub://inbox";

it("listens on real authorized WS, hints without polling/ACK, reconnects, unsubscribes and stops after revocation", async () => {
  const baseUrl = "http://127.0.0.1:8825";
  const hub = buildApp({ NODE_ENV: "production", CORS_ORIGINS: baseUrl });
  const user = crypto.randomUUID();
  const token = hub.ctx.authService.createToken(user, "agents-hub");
  const project = hub.ctx.projectService.createProject("Listener fixture", user).project.project_id;
  const http = new HubClient({ baseUrl, token });
  const server = createMcpServer({
    hubClient: http,
    defaultProjectId: project,
    defaultAgentName: "listener",
  });
  const client = new Client(
    { name: "subscribing-fixture", version: "1.0.0" },
    { capabilities: {} },
  );
  let reads = 0;
  let acks = 0;
  let tickets = 0;
  const notices: unknown[] = [];
  hub.addHook("onRequest", async (req) => {
    if (req.url.includes("/inbox?") && req.method === "GET") reads++;
    if (req.url.endsWith("/inbox/ack")) acks++;
    if (req.url.endsWith("/ws-ticket")) tickets++;
  });
  client.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    (notice: { params: unknown }) => {
      notices.push(notice.params);
    },
  );
  try {
    await hub.listen({ host: "127.0.0.1", port: 8825 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    expect((await client.listResources()).resources[0].uri).toBe(uri);
    await expect(client.readResource({ uri })).rejects.toThrow("join_project");
    await expect(client.subscribeResource({ uri: "agents-hub://other" })).rejects.toThrow();
    await client.subscribeResource({ uri });
    const joined = await client.callTool({ name: "join_project", arguments: {} });
    expect(joined.isError).not.toBe(true);
    const session = JSON.parse(joined.content[0].text).session_id;
    await vi.waitFor(() => expect(hub.ctx.wsHub.getSubscriberCount(project)).toBe(1));
    await vi.waitFor(() => expect(notices.length).toBeGreaterThan(0));
    expect(notices[0]).toEqual({ uri });
    expect(reads).toBe(0);
    const checkpoint = () =>
      hub.ctx.db.prepare("SELECT last_cursor FROM agent_sessions WHERE session_id = ?").get(session)
        ?.last_cursor;
    const before = checkpoint();
    const first = await client.readResource({ uri });
    expect(await client.readResource({ uri })).toEqual(first);
    expect(checkpoint()).toBe(before);
    const sender = await http.createSession(project, "sender");
    await http.createSession(project, "other-agent");
    await sleep(350);
    const notifications = notices.length;
    await http.sendMessage(project, sender.session_id, {
      body: "Mensaje sólo para listener",
      recipient_agent_ids: ["listener"],
    });
    await vi.waitFor(() => expect(notices.length).toBeGreaterThan(notifications));
    expect(reads).toBe(2); // Hints never read or ACK autonomously.
    const page = await client.readResource({ uri });
    expect(page.contents[0].text).toContain("Mensaje sólo para listener");
    expect(acks).toBe(0);
    expect(checkpoint()).toBe(before);
    const privateNotices = notices.length;
    await http.sendMessage(project, sender.session_id, {
      body: "Privado para otro",
      recipient_agent_ids: ["other-agent"],
    });
    await sleep(350);
    expect(notices.length).toBe(privateNotices);
    expect((await client.readResource({ uri })).contents[0].text).not.toContain(
      "Privado para otro",
    );
    await client.unsubscribeResource({ uri });
    const unsubscribed = notices.length;
    await http.sendMessage(project, sender.session_id, { body: "Sin suscripción" });
    await sleep(350);
    expect(notices.length).toBe(unsubscribed);
    await client.subscribeResource({ uri });
    hub.ctx.wsHub.closeAll(1012, "Synthetic reconnect");
    await vi.waitFor(() => expect(tickets).toBeGreaterThan(1), { timeout: 4000 });
    await vi.waitFor(() => expect(notices.length).toBeGreaterThan(unsubscribed));
    expect(hub.ctx.wsHub.getSubscriberCount(project)).toBe(1);
    expect(acks).toBe(0);
    expect(reads).toBe(4);
    hub.ctx.authService.revokeToken(hub.ctx.authService.verifyToken(token).tokenId, user);
    hub.ctx.wsHub.revalidate();
    await vi.waitFor(() => expect(hub.ctx.wsHub.getSubscriberCount(project)).toBe(0));
    const stoppedTickets = tickets;
    await sleep(1100);
    expect(tickets).toBe(stoppedTickets);
    await expect(client.readResource({ uri })).rejects.toThrow();
    await server.shutdown();
    expect(hub.ctx.wsHub.getSubscriberCount()).toBe(0);
  } finally {
    await server.shutdown();
    await client.close();
    await server.close();
    await hub.close();
    hub.ctx.db.close();
  }
}, 15000);
