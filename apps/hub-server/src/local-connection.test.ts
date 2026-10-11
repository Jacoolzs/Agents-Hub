import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  NativeSecretStore,
  loadLocalConnection,
  privateDirectory,
  verifyPrivatePath,
} from "@agents-hub/config";
import { describe, expect, it } from "vitest";
import { HubClient } from "../../../packages/mcp-server/src/client/hub-client.js";
import { runDoctor } from "../../../scripts/doctor.mjs";
import { createMcpConfig } from "../../../scripts/mcp-config.mjs";
import { buildApp } from "./app.js";

const sdkRequire = createRequire(path.resolve("packages/mcp-server/package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdkRequire("@modelcontextprotocol/sdk/client/stdio.js");
const native =
  process.platform === "win32" ||
  (process.platform === "linux" && process.env.AGENTS_HUB_TEST_ISOLATED_KEYRING === "1");

describe("native local reference integration", () => {
  it.skipIf(!native)(
    "runs doctor and MCP stdio without bearer environment, respects revocation and missing vault",
    async () => {
      if (process.platform === "linux") {
        const isolated = process.env.AGENTS_HUB_TEST_KEYRING_ROOT;
        if (
          !isolated ||
          process.env.HOME !== isolated ||
          !process.env.DBUS_SESSION_BUS_ADDRESS ||
          process.env.XDG_DATA_HOME !== path.join(isolated, "data") ||
          process.env.XDG_RUNTIME_DIR !== path.join(isolated, "runtime")
        )
          throw new Error("Native test requires isolated Secret Service fixture");
      }
      const root = await mkdtemp(path.join(tmpdir(), "hub-native-connection-"));
      const directory = path.join(root, "profiles");
      await privateDirectory(directory);
      const credentialId = randomUUID();
      const store = new NativeSecretStore(path.join(directory, "credentials"));
      const origin = "http://127.0.0.1:8795";
      const hub = buildApp({ NODE_ENV: "production", CORS_ORIGINS: origin });
      const client = new Client(
        { name: "native-reference-test", version: "1.0.0" },
        { capabilities: {} },
      );
      let stored = false;
      let stderr = "";
      try {
        const owner = randomUUID();
        const project = hub.ctx.projectService.createProject("Native connection", owner).project
          .project_id;
        let redirectTargets = 0;
        hub.get("/fixture-redirect", (_request, reply) => reply.redirect("/fixture-target"));
        hub.get("/fixture-target", () => {
          redirectTargets++;
          return { data: {} };
        });
        await hub.listen({ host: "127.0.0.1", port: 0 });
        const base = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
        const requested = await fetch(`${base}/v1/devices/requests`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "Native test" }),
        });
        expect(requested.status).toBe(200);
        const request = (await requested.json()).data;
        const entry = hub.ctx.webAccessService.issueEntry(owner, { project_id: project }, "test");
        const headers = { host: "127.0.0.1:8795", origin };
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
        const preview = await hub.inject({
          method: "POST",
          url: "/v1/web/devices/preview",
          headers: auth,
          payload: { request_id: request.request_id },
        });
        expect(preview.statusCode).toBe(200);
        expect(
          (
            await hub.inject({
              method: "POST",
              url: "/v1/web/devices/approve",
              headers: auth,
              payload: {
                request_id: request.request_id,
                confirm: true,
                approval: preview.json().data.approval,
              },
            })
          ).statusCode,
        ).toBe(200);
        const exchanged = await fetch(`${base}/v1/devices/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_secret: request.device_secret }),
        });
        expect(exchanged.status).toBe(200);
        const credential = (await exchanged.json()).data;
        await store.put(credentialId, credential.token);
        stored = true;
        const file = path.join(directory, `${credentialId}.json`);
        await writeFile(
          file,
          JSON.stringify({
            version: 1,
            credential_id: credentialId,
            hub_url: base,
            project_id: project,
            token_id: credential.token_id,
            expires_at: credential.expires_at,
          }),
          { flag: "wx", mode: 0o600 },
        );
        await verifyPrivatePath(file, true);
        const env = { AGENTS_HUB_CONNECTION_FILE: file };
        const snapshot = () =>
          Object.fromEntries(
            [
              "events",
              "agent_sessions",
              "messages",
              "workspace_locks",
              "audit_entries",
              "idempotency_records",
            ].map((table) => [
              table,
              hub.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
            ]),
          );
        const before = snapshot();
        const methods: string[] = [];
        const result = await runDoctor({
          env,
          runtimeVersion: "24.12.0",
          fetchImpl: (url: string, options: RequestInit) => {
            methods.push(options.method ?? "GET");
            return fetch(url, options);
          },
        });
        expect(result.ok).toBe(true);
        expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
        expect(snapshot()).toEqual(before);
        expect(JSON.stringify(result)).not.toContain(credential.token);
        const config = createMcpConfig({ connectionFile: file, agentName: "native-agent" })
          .mcpServers["agents-hub"];
        expect(Object.keys(config.env).sort()).toEqual([
          "AGENTS_HUB_AGENT_NAME",
          "AGENTS_HUB_CONNECTION_FILE",
        ]);
        expect(JSON.stringify(config)).not.toContain(credential.token);
        const inherited = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined &&
              !entry[0].startsWith("AGENTS_HUB_") &&
              !["NODE_OPTIONS", "NODE_PATH"].includes(entry[0]),
          ),
        );
        const cli = await promisify(execFile)(
          process.execPath,
          [path.resolve("scripts/doctor.mjs"), "--json"],
          { env: { ...inherited, ...env, NODE_ENV: "production" } },
        );
        expect(JSON.parse(cli.stdout).ok).toBe(true);
        expect(cli.stdout + cli.stderr).not.toContain(credential.token);
        expect(snapshot()).toEqual(before);
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...inherited, ...config.env, NODE_ENV: "production" },
          stderr: "pipe",
        });
        transport.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        await client.connect(transport);
        expect((await client.callTool({ name: "join_project", arguments: {} })).isError).not.toBe(
          true,
        );
        const sent = await client.callTool({
          name: "send_team_message",
          arguments: { body: "Native reference verified" },
        });
        expect(sent.isError).not.toBe(true);
        expect(JSON.parse(sent.content[0].text).body).toBe("Native reference verified");
        const redirect = await fetch(`${base}/fixture-redirect`, {
          headers: { Authorization: `Bearer ${credential.token}` },
          redirect: "manual",
        });
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toBe("/fixture-target");
        await expect(
          new HubClient({ baseUrl: base, token: credential.token }).request("/fixture-redirect"),
        ).rejects.toThrow();
        expect(redirectTargets).toBe(0);
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
        const denied = await runDoctor({ env, runtimeVersion: "24.12.0" });
        expect(
          denied.checks.find((check: { name: string }) => check.name === "identity")?.code,
        ).toBe("UNAUTHENTICATED");
        expect(JSON.stringify({ rejected, denied }) + stderr).not.toContain(credential.token);
        await client.close();
        await store.remove(credentialId);
        stored = false;
        await expect(loadLocalConnection(file)).rejects.toMatchObject({
          code: "CREDENTIAL_UNAVAILABLE",
        });
        await store.put(credentialId, "ahd_NOT_AN_MCP_BEARER");
        stored = true;
        await expect(loadLocalConnection(file)).rejects.toMatchObject({
          code: "CREDENTIAL_UNAVAILABLE",
        });
      } finally {
        await client.close();
        await hub.close();
        hub.ctx.db.close();
        if (stored) await store.remove(credentialId);
        await rm(root, { recursive: true, force: true });
      }
    },
    90000,
  );
});
