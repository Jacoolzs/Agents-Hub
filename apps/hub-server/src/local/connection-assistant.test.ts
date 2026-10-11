import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeSecretStore, loadLocalConnection, verifyPrivatePath } from "@agents-hub/config";
import { describe, expect, it, vi } from "vitest";
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
        } finally {
          await new NativeSecretStore(path.join(directory, "credentials")).remove(
            start.connection_id,
          );
        }
      }),
    90000,
  );
});
