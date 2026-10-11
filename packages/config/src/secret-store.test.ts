import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateDirectory, verifyPrivatePath } from "./private-directory.js";
import { NativeSecretStore } from "./secret-store.js";

let temporary: string;
beforeAll(async () => {
  if (process.platform === "linux" && process.env.AGENTS_HUB_TEST_ISOLATED_KEYRING === "1") {
    const root = process.env.AGENTS_HUB_TEST_KEYRING_ROOT;
    if (
      !root ||
      process.env.HOME !== root ||
      !process.env.DBUS_SESSION_BUS_ADDRESS ||
      process.env.XDG_DATA_HOME !== join(root, "data") ||
      process.env.XDG_RUNTIME_DIR !== join(root, "runtime")
    )
      throw new Error("Native Linux tests require the dedicated CI bus/home/keyring fixture");
  }
  temporary = await mkdtemp(join(tmpdir(), "Agents-Hub secret-store test-"));
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});
const directory = () => join(temporary, randomUUID());
const native =
  process.platform === "win32" ||
  (process.platform === "linux" && process.env.AGENTS_HUB_TEST_ISOLATED_KEYRING === "1");

describe("native credential boundaries", () => {
  it("rejects relative and filesystem-root directories", () => {
    expect(() => new NativeSecretStore("relative")).toThrow("absolute dedicated");
    expect(() => new NativeSecretStore(process.platform === "win32" ? "C:\\" : "/")).toThrow(
      "absolute dedicated",
    );
  });
  it("rejects identifiers and values before creating directories", async () => {
    const path = directory();
    const store = new NativeSecretStore(path);
    await expect(store.put("../escape", "synthetic")).rejects.toThrow("saved securely");
    for (const value of ["", "a\0b", "a".repeat(2049), "\ud800"])
      await expect(store.put(randomUUID(), value)).rejects.toThrow();
    await expect(readdir(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("missing reads and removal do not initialize a vault", async () => {
    const path = directory();
    const store = new NativeSecretStore(path);
    expect(await store.get(randomUUID())).toBeUndefined();
    await store.remove(randomUUID());
    await expect(readdir(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("blocks symlink/junction ancestors", async () => {
    const target = directory();
    const link = directory();
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await expect(
      new NativeSecretStore(join(link, "vault")).put(randomUUID(), "synthetic"),
    ).rejects.toThrow("saved securely");
    expect(await readdir(target)).toEqual([]);
  });
  it("preserves partial and foreign reservations", async () => {
    const path = directory();
    const id = randomUUID();
    await privateDirectory(path);
    await privateDirectory(join(path, id));
    const store = new NativeSecretStore(path);
    await expect(store.get(id)).rejects.toThrow("read securely");
    await expect(store.put(id, "synthetic")).rejects.toThrow("saved securely");
    const foreign = join(path, id, "foreign.txt");
    await writeFile(foreign, "unrelated", { mode: 0o600 });
    await expect(store.remove(id)).rejects.toThrow("removal failed");
    expect(await readFile(foreign, "utf8")).toBe("unrelated");
  }, 20000);
  it("removes an empty owned partial reservation", async () => {
    const path = directory();
    const id = randomUUID();
    await privateDirectory(path);
    await privateDirectory(join(path, id));
    await new NativeSecretStore(path).remove(id);
    expect(await readdir(path)).toEqual([]);
  }, 20000);
  it.skipIf(process.platform === "win32")(
    "rejects broad Unix permissions without repair",
    async () => {
      const path = directory();
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o755);
      await expect(new NativeSecretStore(path).get(randomUUID())).rejects.toThrow("read securely");
      await expect(verifyPrivatePath(path)).rejects.toThrow("unsafe permissions");
    },
  );
});

it.skipIf(process.platform !== "linux")(
  "missing Secret Service fails closed and preserves reservation",
  async () => {
    const previousPath = process.env.PATH;
    const path = directory();
    const store = new NativeSecretStore(path);
    const id = randomUUID();
    const absentTools = directory();
    await mkdir(absentTools);
    try {
      process.env.PATH = absentTools;
      await expect(store.put(id, "synthetic-no-provider")).rejects.toThrow("saved securely");
      expect(await readFile(join(path, id, "record.json"), "utf8")).not.toContain(
        "synthetic-no-provider",
      );
      await expect(store.get(id)).rejects.toThrow("read securely");
      await expect(store.remove(id)).rejects.toThrow("removal failed");
      expect(await readdir(join(path, id))).toEqual(["record.json"]);
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = previousPath;
    }
  },
);

describe.skipIf(!native)("real isolated native provider", () => {
  it("round-trips, rejects replacement, removes only its own device", async () => {
    const path = directory();
    const store = new NativeSecretStore(path);
    const id = randomUUID();
    const other = randomUUID();
    const value = `synthetic-only-${randomUUID()}-ñ-🌴`;
    try {
      await store.put(id, value);
      await store.put(other, "x".repeat(2048));
      expect(await store.get(id)).toBe(value);
      await expect(store.put(id, "replacement")).rejects.toThrow("saved securely");
      expect(await store.get(id)).toBe(value);
      expect(await readFile(join(path, id, "record.json"), "utf8")).not.toContain(value);
      await verifyPrivatePath(path);
      await verifyPrivatePath(join(path, id));
      await verifyPrivatePath(join(path, id, "record.json"));
      await store.remove(id);
      await store.remove(id);
      expect(await store.get(id)).toBeUndefined();
      expect(await store.get(other)).toBe("x".repeat(2048));
    } finally {
      await store.remove(id);
      await store.remove(other);
    }
  }, 60000);
  it("preserves corrupt records without exposing diagnostics", async () => {
    const path = directory();
    const store = new NativeSecretStore(path);
    const id = randomUUID();
    await store.put(id, "synthetic-corruption-test");
    const recordPath = join(path, id, "record.json");
    const original = await readFile(recordPath, "utf8");
    try {
      await writeFile(recordPath, "invalid-synthetic-marker", { mode: 0o600 });
      await expect(store.get(id)).rejects.toThrow("read securely");
      await expect(store.remove(id)).rejects.toThrow("removal failed");
      expect(await readFile(recordPath, "utf8")).toBe("invalid-synthetic-marker");
    } finally {
      await writeFile(recordPath, original, { mode: 0o600 });
      await store.remove(id);
    }
  }, 30000);
  it.skipIf(process.platform !== "win32")(
    "binds DPAPI ciphertext to directory and device",
    async () => {
      const path = directory();
      const store = new NativeSecretStore(path);
      const source = randomUUID();
      const target = randomUUID();
      await store.put(source, "synthetic-context-only");
      await privateDirectory(join(path, target));
      await writeFile(
        join(path, target, "record.json"),
        await readFile(join(path, source, "record.json")),
        { mode: 0o600 },
      );
      await verifyPrivatePath(join(path, target, "record.json"), true);
      try {
        await expect(store.get(target)).rejects.toThrow("read securely");
      } finally {
        await store.remove(source);
        await store.remove(target);
      }
    },
    30000,
  );
});
