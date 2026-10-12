import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeSecretStore, loadLocalConnection, verifyPrivatePath } from "@agents-hub/config";
import { describe, expect, it, vi } from "vitest";
import { AntigravityImporter } from "./antigravity-importer.js";
import { ConnectionAssistant } from "./connection-assistant.js";

const token = `ah_${"x".repeat(32)}`;
const requestId = randomUUID();
const expires = new Date(Date.now() + 300000).toISOString();
const projectId = randomUUID();
const tokenId = randomUUID();
const reply = (data: unknown) => new Response(JSON.stringify({ data }));
function network() {
  return vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/requests")
      ? reply({
          request_id: requestId,
          expires_at: expires,
          device_secret: `ahd_${"s".repeat(43)}`,
        })
      : reply({ token, token_id: tokenId, project_id: projectId, expires_at: expires }),
  );
}
function vault() {
  const values = new Map<string, string>();
  return {
    values,
    put: vi.fn(async (id: string, value: string) => {
      if (values.has(id)) throw new Error("Already reserved");
      values.set(id, value);
    }),
    get: vi.fn(async (id: string) => values.get(id)),
    remove: vi.fn(async (id: string) => {
      values.delete(id);
    }),
  };
}
async function fixture(work: (directory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "ah-assistant-test-"));
  try {
    await work(path.join(root, "connections"));
  } finally {
    if (
      path.dirname(root) === path.resolve(tmpdir()) &&
      path.basename(root).startsWith("ah-assistant-test-")
    )
      await rm(root, { recursive: true, force: true });
  }
}
const create = (directory: string, http = network(), store = vault()) =>
  new ConnectionAssistant(
    directory,
    path.resolve("packages/mcp-server/dist/main.js"),
    process.execPath,
    http,
    store,
  );

describe("serialized connection writer", () => {
  it(
    "imports only a saved local reference after explicit confirmation without issuance or bearer configuration",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const store = vault();
        const importer = new AntigravityImporter(path.dirname(directory), async () => "1.3.3");
        const assistant = new ConnectionAssistant(
          directory,
          path.resolve("packages/mcp-server/dist/main.js"),
          process.execPath,
          http,
          store,
          importer,
        );
        const start = await assistant.start({
          hub_url: "https://hub.example",
          label: "Import TEMP",
        });
        const saved = await assistant.finish({ connection_id: start.connection_id, confirm: true });
        http.mockClear();
        const preview = await assistant.importPreview({ connection_id: start.connection_id });
        expect(preview.state).toBe("new");
        for (const input of [
          {
            connection_id: start.connection_id,
            preview_id: preview.preview_id,
            confirm: false,
            client_closed: true,
          },
          {
            connection_id: start.connection_id,
            preview_id: preview.preview_id,
            confirm: true,
            client_closed: false,
          },
          {
            connection_id: start.connection_id,
            preview_id: preview.preview_id,
            confirm: true,
            client_closed: true,
            path: "foreign",
          },
        ])
          await expect(assistant.importApply(input)).rejects.toThrow();
        const result = await assistant.importApply({
          connection_id: start.connection_id,
          preview_id: preview.preview_id,
          confirm: true,
          client_closed: true,
        });
        const bytes = await readFile(result.destination, "utf8");
        expect(JSON.parse(bytes)).toEqual(saved.config);
        expect(bytes).not.toContain(token);
        expect(JSON.stringify({ preview, result })).not.toContain(token);
        expect(http).not.toHaveBeenCalled();
      }),
    30000,
  );
  it(
    "diagnoses own references without writes, stops locally on unavailable/expired/invalid profiles",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const store = vault();
        const assistant = create(directory, http, store);
        const start = await assistant.start({ hub_url: "https://hub.example", label: "Diagnosis" });
        const saved = await assistant.finish({ connection_id: start.connection_id, confirm: true });
        const before = await readFile(saved.file, "utf8");
        const puts = store.put.mock.calls.length;
        const removes = store.remove.mock.calls.length;
        http.mockClear();
        http.mockImplementation(async (url) => {
          if (String(url).endsWith("/health/ready")) return reply({ status: "ready" });
          if (String(url).endsWith("/capabilities"))
            return reply({
              api_version: "v1",
              contract_revision: 1,
              features: [
                "exclusive_instances",
                "cursor_recovery",
                "explicit_ack",
                "idempotent_commands",
              ],
            });
          if (String(url).endsWith("/tokens")) return reply([]);
          return reply({ project_id: projectId });
        });
        const report = await assistant.diagnose({ connection_id: start.connection_id });
        expect(report.ok).toBe(true);
        expect(report.checks.at(-1)).toMatchObject({ status: "skipped", code: "WS_NOT_CHECKED" });
        expect(http).toHaveBeenCalledTimes(4);
        expect(await readFile(saved.file, "utf8")).toBe(before);
        expect(store.put).toHaveBeenCalledTimes(puts);
        expect(store.remove).toHaveBeenCalledTimes(removes);
        expect(JSON.stringify(report)).not.toContain(token);
        http.mockClear();
        store.get.mockRejectedValueOnce(new Error(token));
        expect(
          (await assistant.diagnose({ connection_id: start.connection_id })).checks.find(
            (check) => check.name === "connection",
          )?.code,
        ).toBe("CREDENTIAL_UNAVAILABLE");
        await writeFile(
          saved.file,
          JSON.stringify({ ...saved.profile, expires_at: "2000-01-01T00:00:00.000Z" }),
        );
        expect(
          (await assistant.diagnose({ connection_id: start.connection_id })).checks.find(
            (check) => check.name === "connection",
          )?.code,
        ).toBe("CONNECTION_EXPIRED");
        expect(
          (await assistant.diagnose({ connection_id: randomUUID() })).checks.find(
            (check) => check.name === "connection",
          )?.code,
        ).toBe("CONNECTION_INVALID");
        await expect(
          assistant.diagnose({ connection_id: start.connection_id, file: saved.file }),
        ).rejects.toThrow();
        await expect(assistant.diagnose({ connection_id: "../foreign" })).rejects.toThrow();
        expect(http).not.toHaveBeenCalled();
      }),
    30000,
  );
  it(
    "checks provider before network and publishes complete reference/config without secrets",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const store = vault();
        const assistant = create(directory, http, store);
        expect(await assistant.list()).toEqual([]);
        const start = await assistant.start({ hub_url: "http://127.0.0.1:8787", label: "Test PC" });
        expect(store.values.size).toBe(0);
        expect(JSON.stringify(start)).not.toContain("ahd_");
        const result = await assistant.finish({
          connection_id: start.connection_id,
          confirm: true,
        });
        expect(result.profile.token_id).toBe(tokenId);
        expect(store.values.get(start.connection_id)).toBe(token);
        await verifyPrivatePath(result.file);
        expect(JSON.parse(await readFile(result.file, "utf8"))).toEqual(result.profile);
        expect(JSON.stringify(result)).not.toContain(token);
        expect(JSON.stringify(result.config)).not.toContain("AGENTS_HUB_TOKEN");
        expect(result.config.mcpServers["agents-hub"].env.AGENTS_HUB_AGENT_NAME).toBe(
          `Test-PC-${start.connection_id}`,
        );
        expect((await assistant.list())[0]?.state).toBe("saved");
        await expect(
          assistant.finish({ connection_id: start.connection_id, confirm: true }),
        ).rejects.toThrow();
        expect(http).toHaveBeenCalledTimes(2);
        expect(http.mock.calls[1]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
      }),
    30000,
  );
  it(
    "fences lost exchange response and restart without retry or persisted bearer/possession secret",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const assistant = create(directory, http);
        const start = await assistant.start({
          hub_url: "https://hub.example",
          label: "Lost response",
        });
        http.mockImplementationOnce(async () => {
          throw new Error(`Bearer ${token}`);
        });
        await expect(
          assistant.finish({ connection_id: start.connection_id, confirm: true }),
        ).rejects.toThrow("No se completó");
        await expect(
          assistant.finish({ connection_id: start.connection_id, confirm: true }),
        ).rejects.toThrow();
        expect(http).toHaveBeenCalledTimes(2);
        const reopened = create(directory, http);
        expect((await reopened.list())[0]).toMatchObject({
          state: "recovery",
          request_id: requestId,
          token_id: null,
        });
        await expect(
          reopened.finish({ connection_id: start.connection_id, confirm: true }),
        ).rejects.toThrow();
        expect(http).toHaveBeenCalledTimes(2);
        const request = await readFile(
          path.join(directory, "attempts", start.connection_id, "request.json"),
          "utf8",
        );
        expect(request).not.toContain("ahd_");
        expect(request).not.toContain(token);
      }),
    30000,
  );
  it(
    "preserves issuance metadata when secure save fails and never publishes a usable reference",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const store = vault();
        const assistant = create(directory, http, store);
        const start = await assistant.start({
          hub_url: "https://hub.example",
          label: "Save failure",
        });
        store.put.mockImplementation(async (id, value) => {
          if (id === start.connection_id) throw new Error(token);
          store.values.set(id, value);
        });
        await expect(
          assistant.finish({ connection_id: start.connection_id, confirm: true }),
        ).rejects.toThrow("No se completó");
        expect((await assistant.list())[0]).toMatchObject({
          state: "recovery",
          token_id: tokenId,
          file: null,
        });
        await expect(
          readFile(path.join(directory, `${start.connection_id}.json`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await readFile(
            path.join(directory, "attempts", start.connection_id, "connection.json"),
            "utf8",
          ),
        ).not.toContain(token);
      }),
    30000,
  );
  it(
    "rejects unavailable provider, unsafe URL, bad confirmation and concurrent work before issuance",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const store = vault();
        const assistant = create(directory, http, store);
        await expect(
          assistant.start({ hub_url: "http://remote.example", label: "No TLS" }),
        ).rejects.toThrow();
        await expect(
          assistant.finish({ connection_id: randomUUID(), confirm: false }),
        ).rejects.toThrow();
        store.put.mockRejectedValueOnce(new Error("Provider missing"));
        await expect(
          assistant.start({ hub_url: "https://hub.example", label: "Unavailable" }),
        ).rejects.toThrow();
        expect(http).not.toHaveBeenCalled();
        let release!: () => void;
        http.mockImplementationOnce(async () => {
          await new Promise<void>((accept) => {
            release = accept;
          });
          return reply({
            request_id: requestId,
            expires_at: expires,
            device_secret: `ahd_${"s".repeat(43)}`,
          });
        });
        const work = assistant.start({ hub_url: "https://hub.example", label: "One operation" });
        await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 10000 });
        await expect(
          assistant.start({ hub_url: "https://hub.example", label: "Concurrent" }),
        ).rejects.toThrow();
        release();
        await work;
      }),
    30000,
  );
  it(
    "rejects a preexisting reference before exchange without overwriting it",
    async () =>
      fixture(async (directory) => {
        const http = network();
        const assistant = create(directory, http);
        const start = await assistant.start({ hub_url: "https://hub.example", label: "Conflict" });
        const file = path.join(directory, `${start.connection_id}.json`);
        await writeFile(file, "foreign", { flag: "wx", mode: 0o600 });
        await expect(
          assistant.finish({ connection_id: start.connection_id, confirm: true }),
        ).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe("foreign");
        expect(http).toHaveBeenCalledTimes(1);
      }),
    30000,
  );
  const native =
    process.platform === "win32" ||
    (process.platform === "linux" && process.env.AGENTS_HUB_TEST_ISOLATED_KEYRING === "1");
  it.skipIf(!native)(
    "saves with real isolated native provider and reader opens the atomic reference",
    async () =>
      fixture(async (directory) => {
        if (process.platform === "linux") {
          const isolated = process.env.AGENTS_HUB_TEST_KEYRING_ROOT;
          if (
            !isolated ||
            process.env.HOME !== isolated ||
            !process.env.DBUS_SESSION_BUS_ADDRESS ||
            process.env.XDG_DATA_HOME !== path.join(isolated, "data") ||
            process.env.XDG_RUNTIME_DIR !== path.join(isolated, "runtime")
          )
            throw new Error("Isolated keyring required");
        }
        const assistant = new ConnectionAssistant(
          directory,
          path.resolve("packages/mcp-server/dist/main.js"),
          process.execPath,
          network(),
        );
        const start = await assistant.start({
          hub_url: "https://hub.example",
          label: "Native TEMP",
        });
        try {
          const result = await assistant.finish({
            connection_id: start.connection_id,
            confirm: true,
          });
          expect((await loadLocalConnection(result.file)).token).toBe(token);
          const report = await assistant.diagnose({ connection_id: start.connection_id });
          expect(report.checks.find((check) => check.name === "connection")?.code).toBe(
            "LOCAL_CONNECTION_READY",
          );
          expect(JSON.stringify(report)).not.toContain(token);
        } finally {
          await new NativeSecretStore(path.join(directory, "credentials")).remove(
            start.connection_id,
          );
        }
      }),
    90000,
  );
});
