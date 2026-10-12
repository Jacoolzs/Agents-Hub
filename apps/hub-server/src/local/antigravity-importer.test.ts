import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateDirectory, verifyPrivatePath } from "@agents-hub/config";
import { describe, expect, it, vi } from "vitest";
import { AntigravityImporter } from "./antigravity-importer.js";

const connection = randomUUID();
const entry = {
  command: process.execPath,
  args: [path.resolve("packages/mcp-server/dist/main.js")],
  env: {
    AGENTS_HUB_CONNECTION_FILE: path.join(tmpdir(), `${connection}.json`),
    AGENTS_HUB_AGENT_NAME: `test-${connection}`,
  },
};
async function fixture(work: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "ah-client-import-test-"));
  try {
    await work(home);
  } finally {
    if (
      path.dirname(home) === path.resolve(tmpdir()) &&
      path.basename(home).startsWith("ah-client-import-test-")
    )
      await rm(home, { recursive: true, force: true });
  }
}
async function seed(home: string, bytes: string) {
  await privateDirectory(path.join(home, ".gemini"));
  await privateDirectory(path.join(home, ".gemini", "config"));
  const file = path.join(home, ".gemini", "config", "mcp_config.json");
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  await verifyPrivatePath(file, true, 262144);
  return file;
}
describe("Antigravity profile importer in TEMP only", () => {
  it(
    "does not reinterpret a displaced/crashed original as an empty new profile",
    async () =>
      fixture(async (home) => {
        const file = await seed(home, '{"mcpServers":{"other":{"command":"keep"}}}');
        const operation = path.join(path.dirname(file), `.agents-hub-import-${randomUUID()}`);
        await privateDirectory(operation);
        const { rename } = await import("node:fs/promises");
        await rename(file, path.join(operation, "original.json"));
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        await expect(importer.preview(connection, entry)).rejects.toThrow();
        await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(operation, "original.json"), "utf8")).toContain("keep");
      }),
    30000,
  );
  it(
    "rechecks consent expiry after asynchronous work before publishing",
    async () =>
      fixture(async (home) => {
        let expired: ReturnType<typeof vi.spyOn> | undefined;
        const importer = new AntigravityImporter(
          home,
          async () => "1.3.3",
          async () => {
            expired = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
          },
        );
        const preview = await importer.preview(connection, entry);
        try {
          await expect(
            importer.apply(connection, String(preview.preview_id), entry),
          ).rejects.toThrow();
        } finally {
          expired?.mockRestore();
        }
        await expect(readFile(importer.destination)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(importer.preview(connection, entry)).rejects.toThrow();
      }),
    30000,
  );
  it(
    "refuses adding past the entry limit before creating an operation",
    async () =>
      fixture(async (home) => {
        const bytes = JSON.stringify({
          mcpServers: Object.fromEntries(
            Array.from({ length: 1000 }, (_, index) => [`other-${index}`, { command: "keep" }]),
          ),
        });
        const file = await seed(home, bytes);
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        expect(await importer.preview(connection, entry)).toMatchObject({
          state: "blocked",
          preview_id: null,
          count: 1000,
        });
        expect(await readFile(file, "utf8")).toBe(bytes);
        expect(await readdir(path.dirname(file))).toEqual(["mcp_config.json"]);
      }),
    30000,
  );
  it(
    "rejects non-UTF8 bytes instead of silently changing a foreign setting",
    async () =>
      fixture(async (home) => {
        const file = await seed(home, "{}");
        const raw = Buffer.concat([
          Buffer.from('{"mcpServers":{},"value":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]);
        await writeFile(file, raw);
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        await expect(importer.preview(connection, entry)).rejects.toThrow();
        expect(await readFile(file)).toEqual(raw);
      }),
    30000,
  );
  it.skipIf(process.platform === "win32")(
    "rejects permissive files without changing their mode",
    async () =>
      fixture(async (home) => {
        const file = await seed(home, "{}");
        await chmod(file, 0o644);
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        await expect(importer.preview(connection, entry)).rejects.toThrow();
        expect((await lstat(file)).mode & 0o777).toBe(0o644);
        expect(await readFile(file, "utf8")).toBe("{}");
      }),
  );
  it(
    "previews without creating files, registers a complete reference and is idempotent",
    async () =>
      fixture(async (home) => {
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        const preview = await importer.preview(connection, entry);
        expect(preview.state).toBe("new");
        expect(await readdir(home)).toEqual([]);
        const result = await importer.apply(connection, String(preview.preview_id), entry);
        expect(result.backup).toBeNull();
        expect(JSON.parse(await readFile(result.destination, "utf8"))).toEqual({
          mcpServers: { "agents-hub": entry },
        });
        expect((await lstat(result.destination)).nlink).toBe(1);
        await verifyPrivatePath(result.destination);
        await expect(importer.apply(connection, String(preview.preview_id), entry)).rejects.toThrow(
          "No se completó la importación",
        );
        const repeat = await importer.preview(connection, entry);
        expect(repeat.state).toBe("already");
        expect(
          (await importer.apply(connection, String(repeat.preview_id), entry)).backup,
        ).toBeNull();
      }),
    30000,
  );
  it(
    "preserves every foreign setting and the exact private original without disclosing its secrets",
    async () =>
      fixture(async (home) => {
        const secret = "foreign-config-secret-no-output";
        const foreign = {
          mcpServers: { other: { command: "foreign", env: { TOKEN: secret }, disabled: true } },
          extra: { nested: [false, "{quoted}"], long: "x".repeat(5000) },
        };
        const bytes = JSON.stringify(foreign, null, 4);
        const file = await seed(home, bytes);
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        const preview = await importer.preview(connection, entry);
        expect(preview).toMatchObject({ state: "merge", count: 1 });
        const result = await importer.apply(connection, String(preview.preview_id), entry);
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
          ...foreign,
          mcpServers: { ...foreign.mcpServers, "agents-hub": entry },
        });
        expect(await readFile(String(result.backup), "utf8")).toBe(bytes);
        await verifyPrivatePath(String(result.backup), false, 262144);
        expect(JSON.stringify({ preview, result })).not.toContain(secret);
      }),
    30000,
  );
  it(
    "refuses a conflicting entry and stale preview without touching current bytes",
    async () =>
      fixture(async (home) => {
        const file = await seed(home, '{"mcpServers":{}}');
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        const preview = await importer.preview(connection, entry);
        const changed = '{"mcpServers":{"agents-hub":{"command":"foreign"}}}';
        await writeFile(file, changed);
        await expect(
          importer.apply(connection, String(preview.preview_id), entry),
        ).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(changed);
        expect((await importer.preview(connection, entry)).state).toBe("blocked");
        expect(await readdir(path.dirname(file))).toEqual(["mcp_config.json"]);
      }),
    30000,
  );
  it(
    "refuses malformed, duplicate, non-object, deep and oversized JSON without repairing it",
    async () =>
      fixture(async (home) => {
        const file = await seed(home, "{}");
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        for (const bytes of [
          "broken",
          "[]",
          '{"mcpServers":null}',
          '{"a":1,"a":2}',
          '{"mcpServers":{"other":{"env":{"X":"one","\\u0058":"two"}}}}',
          `${"[ ".repeat(65)}0${"]".repeat(65)}`,
          "x".repeat(262145),
        ]) {
          await writeFile(file, bytes);
          await expect(importer.preview(connection, entry)).rejects.toThrow(
            "No se completó la importación",
          );
          expect(await readFile(file, "utf8")).toBe(bytes);
        }
      }),
    30000,
  );
  it(
    "blocks unknown version before reading profiles and detects changes at confirmation",
    async () =>
      fixture(async (home) => {
        const version = vi.fn(async (): Promise<string | null> => null);
        const importer = new AntigravityImporter(home, version);
        expect((await importer.preview(connection, entry)).state).toBe("blocked");
        expect(await readdir(home)).toEqual([]);
        version.mockResolvedValue("1.3.3");
        const preview = await importer.preview(connection, entry);
        version.mockResolvedValue("9.0.0");
        await expect(
          importer.apply(connection, String(preview.preview_id), entry),
        ).rejects.toThrow();
        expect(await readdir(home)).toEqual([]);
        const another = new AntigravityImporter(home, async () => "1.3.3");
        const wrong = await another.preview(connection, entry);
        await expect(
          another.apply(randomUUID(), String(wrong.preview_id), entry),
        ).rejects.toThrow();
        await expect(another.apply(connection, String(wrong.preview_id), entry)).rejects.toThrow();
        const expired = await another.preview(connection, entry);
        const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
        try {
          await expect(
            another.apply(connection, String(expired.preview_id), entry),
          ).rejects.toThrow();
        } finally {
          now.mockRestore();
        }
      }),
    30000,
  );
  it(
    "never overwrites a competing publication and preserves the private original on failure",
    async () =>
      fixture(async (home) => {
        const bytes = '{"mcpServers":{"other":{"command":"keep"}}}';
        const file = await seed(home, bytes);
        const competing = '{"mcpServers":{"third":{"command":"new-writer"}}}';
        const importer = new AntigravityImporter(
          home,
          async () => "1.3.3",
          async () => {
            await writeFile(file, competing, { flag: "wx", mode: 0o600 });
          },
        );
        const preview = await importer.preview(connection, entry);
        await expect(
          importer.apply(connection, String(preview.preview_id), entry),
        ).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(competing);
        const operation = (await readdir(path.dirname(file))).find((name) =>
          name.startsWith(".agents-hub-import-"),
        );
        expect(operation).toBeDefined();
        expect(
          await readFile(path.join(path.dirname(file), String(operation), "original.json"), "utf8"),
        ).toBe(bytes);
      }),
    30000,
  );
  it(
    "restores only when absent and leaves explicit recovery metadata after an interrupted publication",
    async () =>
      fixture(async (home) => {
        const bytes = '{"mcpServers":{"other":{"command":"keep"}}}';
        const file = await seed(home, bytes);
        const importer = new AntigravityImporter(
          home,
          async () => "1.3.3",
          async () => {
            throw new Error("Simulated interruption");
          },
        );
        const preview = await importer.preview(connection, entry);
        await expect(
          importer.apply(connection, String(preview.preview_id), entry),
        ).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(bytes);
        // Restoration retains original backup hardlink; do not pretend this needs no review/repair.
        expect((await lstat(file)).nlink).toBe(2);
        await expect(importer.preview(connection, entry)).rejects.toThrow();
      }),
    30000,
  );
  it(
    "rejects linked profiles without touching the target",
    async () =>
      fixture(async (home) => {
        const file = await seed(home, "{}");
        await link(file, path.join(home, "foreign-link.json"));
        const importer = new AntigravityImporter(home, async () => "1.3.3");
        await expect(importer.preview(connection, entry)).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe("{}");
      }),
    30000,
  );
  it.skipIf(process.platform === "win32")("rejects symlinked ancestors without repair", async () =>
    fixture(async (home) => {
      const target = path.join(home, "foreign");
      await privateDirectory(target);
      await symlink(target, path.join(home, ".gemini"), "dir");
      const importer = new AntigravityImporter(home, async () => "1.3.3");
      await expect(importer.preview(connection, entry)).rejects.toThrow();
      expect(await readdir(target)).toEqual([]);
    }),
  );
});
