import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalConnectionSchema,
  loadLocalConnection,
  resolveAgentConnection,
} from "./local-connection.js";
import { privateDirectory, verifyPrivatePath } from "./private-directory.js";

describe("read-only local connection boundaries", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-reference-test-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const metadata = () => ({
    version: 1,
    credential_id: randomUUID(),
    hub_url: "https://hub.example.test",
    project_id: randomUUID(),
    token_id: randomUUID(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  });
  async function fixture(value: object | string, name?: string) {
    const directory = join(root, randomUUID());
    await privateDirectory(directory);
    const file = join(
      directory,
      name ?? `${(value as { credential_id: string }).credential_id}.json`,
    );
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyPrivatePath(file, true);
    return file;
  }
  it("retains explicit legacy mode and refuses every mixed reference/legacy input, even empty", async () => {
    expect(await resolveAgentConnection({ AGENTS_HUB_TOKEN: "test" })).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      token: "test",
      projectId: undefined,
    });
    await expect(resolveAgentConnection({})).rejects.toThrow("required");
    for (const key of ["AGENTS_HUB_TOKEN", "AGENTS_HUB_URL", "AGENTS_HUB_PROJECT_ID"]) {
      await expect(
        resolveAgentConnection({ AGENTS_HUB_CONNECTION_FILE: "missing", [key]: "" }),
      ).rejects.toMatchObject({ code: "CONNECTION_CONFLICT" });
    }
  });
  it("validates the exact metadata schema and safe destination", () => {
    const value = metadata();
    expect(LocalConnectionSchema.parse(value)).toEqual(value);
    for (const patch of [
      { token: "ah_PRIVATE_TEST_CREDENTIAL" },
      { credential_id: "../other" },
      { expires_at: "tomorrow" },
      { expires_at: "2026-10-11" },
      { hub_url: "http://remote.example.test" },
      { hub_url: "https://user:password@example.test" },
      { hub_url: "https://example.test/?token=x" },
      { hub_url: "https://example.test/#x" },
      { hub_url: "https://example.test/ahp_PRIVATE_APPROVAL_PROOF" },
    ]) {
      expect(() => LocalConnectionSchema.parse({ ...value, ...patch })).toThrow();
    }
  });
  it("rejects missing, corrupt, oversized and mismatched references without echoing input", async () => {
    const credential = "ah_PRIVATE_TEST_CREDENTIAL";
    const oversized = await fixture(metadata());
    await writeFile(oversized, "x".repeat(4097));
    for (const file of [
      join(root, "missing.json"),
      await fixture(credential, `${randomUUID()}.json`),
      oversized,
      await fixture(metadata(), `${randomUUID()}.json`),
      "relative.json",
    ]) {
      await expect(loadLocalConnection(file)).rejects.toMatchObject({
        code: "CONNECTION_INVALID",
        message: expect.not.stringContaining(credential),
      });
    }
  }, 30000);
  it("rejects expired metadata before accessing any native vault", async () => {
    const file = await fixture({ ...metadata(), expires_at: "2020-01-01T00:00:00.000Z" });
    await expect(loadLocalConnection(file)).rejects.toMatchObject({ code: "CONNECTION_EXPIRED" });
  }, 15000);
  it("does not create a vault or fall back when the credential is missing", async () => {
    const file = await fixture(metadata());
    await expect(loadLocalConnection(file)).rejects.toMatchObject({
      code: "CREDENTIAL_UNAVAILABLE",
    });
    await expect(lstat(join(file, "..", "credentials"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);
  it.skipIf(process.platform === "win32")(
    "rejects broad permissions and links without repairing them",
    async () => {
      const file = await fixture(metadata());
      await chmod(file, 0o644);
      await expect(loadLocalConnection(file)).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
      expect((await lstat(file)).mode & 0o777).toBe(0o644);
      await chmod(file, 0o600);
      const link = join(root, `${randomUUID()}.json`);
      await symlink(file, link);
      await expect(loadLocalConnection(link)).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    },
  );
});
