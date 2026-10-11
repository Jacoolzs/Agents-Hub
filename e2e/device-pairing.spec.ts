import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildApp } from "../apps/hub-server/src/app.js";

const sdkRequire = createRequire(path.resolve("packages/mcp-server/package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdkRequire("@modelcontextprotocol/sdk/client/stdio.js");

test("credencial emparejada conecta MCP stdio y revocación humana corta su acceso", async () => {
  const origin = "http://127.0.0.1:8795";
  const headers = { host: "127.0.0.1:8795", origin };
  const hub = buildApp({ NODE_ENV: "production", CORS_ORIGINS: origin });
  const client = new Client({ name: "paired-preview", version: "1.0.0" }, { capabilities: {} });
  try {
    const user = crypto.randomUUID();
    const project = hub.ctx.projectService.createProject("Pairing E2E", user).project.project_id;
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
    const created = await fetch(`${base}/v1/devices/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "MCP de prueba" }),
    });
    expect(created.status).toBe(200);
    const request = (await created.json()).data;
    const entry = hub.ctx.webAccessService.issueEntry(user, { project_id: project }, "e2e");
    const accepted = await hub.inject({
      method: "POST",
      url: "/v1/web/entry",
      headers,
      payload: { secret: entry.secret },
    });
    expect(accepted.statusCode).toBe(200);
    const auth = {
      ...headers,
      cookie: String(accepted.headers["set-cookie"]).split(";")[0] as string,
    };
    expect(
      (
        await hub.inject({
          method: "POST",
          url: "/v1/web/devices/approve",
          headers: auth,
          payload: { request_id: request.request_id, confirm: true },
        })
      ).statusCode,
    ).toBe(200);
    const exchange = await fetch(`${base}/v1/devices/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_secret: request.device_secret }),
    });
    expect(exchange.status).toBe(200);
    const credential = (await exchange.json()).data;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
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
          AGENTS_HUB_TOKEN: credential.token,
          AGENTS_HUB_PROJECT_ID: project,
          AGENTS_HUB_AGENT_NAME: "paired-agent",
        },
        stderr: "pipe",
      }),
    );
    const joined = await client.callTool({ name: "join_project", arguments: {} });
    expect(joined.isError).not.toBe(true);
    const sent = await client.callTool({
      name: "send_team_message",
      arguments: { body: "Conexión emparejada comprobada" },
    });
    expect(sent.isError).not.toBe(true);
    expect(JSON.parse(sent.content[0].text).body).toBe("Conexión emparejada comprobada");
    expect(
      (
        await hub.inject({
          method: "POST",
          url: `/v1/web/devices/${credential.token_id}/revoke`,
          headers: auth,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(200);
    const rejected = await client.callTool({ name: "get_team_status", arguments: {} });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("UNAUTHENTICATED");
    expect(JSON.stringify(rejected)).not.toContain(credential.token);
    expect((await hub.inject({ url: "/v1/web/session", headers: auth })).statusCode).toBe(200);
  } finally {
    await client.close();
    await hub.close();
    hub.ctx.db.close();
  }
});
