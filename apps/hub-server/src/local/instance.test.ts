import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LocalInstance } from "./instance.js";
import { verifyPrivatePath } from "./private-directory.js";

const directories: string[] = [];
const owners: LocalInstance[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith("ah-ipc-")
    )
      throw new Error("Unsafe test directory");
    await rm(directory, { recursive: true, force: true });
  }
});
async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), "ah-ipc-"));
  directories.push(result);
  return result;
}
async function owner(data: string) {
  const acquired = await LocalInstance.acquire(data, "test-instance");
  if (typeof acquired === "string") throw new Error("Unexpected second instance");
  owners.push(acquired);
  return acquired;
}
async function exchange(address: string, payload: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(address);
    let response = "";
    const timer = setTimeout(() => socket.destroy(), 4000);
    socket.once("error", reject);
    socket.on("data", (bytes: Buffer) => {
      response += bytes.toString();
    });
    socket.once("connect", () => socket.end(`${payload}\n`));
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

describe("private companion instance", () => {
  it("fails closed for a live unresponsive owner or impostor instead of deleting the lease", async () => {
    const data = await directory();
    await owner(data);
    const file = path.join(data, ".companion-control/instance.json");
    const record = JSON.parse(await readFile(file, "utf8")) as { address: string };
    await expect(LocalInstance.acquire(data, "test-instance")).rejects.toThrow("unavailable");
    expect((await stat(file)).isFile()).toBe(true);
    // An impostor has no key: plausible encrypted fields cannot authenticate an entry.
    const impostor = createServer((socket) => {
      socket.once("data", () =>
        socket.end(
          `${JSON.stringify({ iv: "00".repeat(12), tag: "00".repeat(16), ciphertext: "00" })}\n`,
        ),
      );
      socket.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      impostor.once("error", reject);
      impostor.listen(record.address, resolve);
    });
    try {
      await expect(LocalInstance.acquire(data, "test-instance")).rejects.toThrow("unavailable");
      expect((await stat(file)).isFile()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  }, 25000);
  it("reopens only matching identity, keeps ownership, and removes its lease on clean close", async () => {
    const data = await directory();
    const instance = await owner(data);
    let entries = 0;
    await instance.serve(() => `test-entry-${++entries}`);
    expect((await LocalInstance.acquire(data, "test-instance")) === "test-entry-1").toBe(true);
    await expect(LocalInstance.acquire(data, "another-instance")).rejects.toThrow(
      "identity mismatch",
    );
    expect(entries).toBe(1);
    await instance.close();
    expect(
      await stat(path.join(data, ".companion-control/instance.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const replacement = await owner(data);
    await replacement.close();
  }, 20000);

  it("never replaces an abandoned v1 record without proof of ownership", async () => {
    const data = await directory();
    const instance = await owner(data);
    const file = path.join(data, ".companion-control/instance.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    await instance.close();
    record.version = 1;
    if (process.platform !== "win32")
      record.address = path.join(data, ".companion-control/reopen.sock");
    await writeFile(file, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await verifyPrivatePath(file, true);
    const original = await readFile(file, "utf8");
    await expect(LocalInstance.acquire(data, "test-instance")).rejects.toThrow("unavailable");
    expect(await readFile(file, "utf8")).toBe(original);
  }, 20000);

  it("rejects stale mismatched or corrupt records without replacing them", async () => {
    const data = await directory();
    const instance = await owner(data);
    const file = path.join(data, ".companion-control/instance.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    await instance.close();
    await writeFile(file, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await verifyPrivatePath(file, true);
    await expect(LocalInstance.acquire(data, "another-instance")).rejects.toThrow(
      "identity mismatch",
    );
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(record));
    for (const contents of ["null", "{", "{}"]) {
      await writeFile(file, contents);
      await expect(LocalInstance.acquire(data, "test-instance")).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  }, 20000);

  it("authenticates IPC, rejects replay/expired/oversized requests and encrypts its response", async () => {
    const data = await directory();
    const instance = await owner(data);
    let entries = 0;
    const privateEntry = "private-test-entry";
    await instance.serve(() => {
      entries++;
      return privateEntry;
    });
    const record = JSON.parse(
      await readFile(path.join(data, ".companion-control/instance.json"), "utf8"),
    ) as { key: string; address: string };
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = Date.now();
    const proof = createHmac("sha256", Buffer.from(record.key, "hex"))
      .update(`${nonce}:test-instance:${timestamp}`)
      .digest("hex");
    expect(
      (await exchange(record.address, JSON.stringify({ nonce, timestamp, proof: "0".repeat(64) })))
        .length,
    ).toBe(0);
    expect(entries).toBe(0);
    const request = JSON.stringify({ nonce, timestamp, proof });
    const response = await exchange(record.address, request);
    expect(
      response.length > 0 && !response.includes(privateEntry) && !response.includes(record.key),
    ).toBe(true);
    expect(entries).toBe(1);
    expect((await exchange(record.address, request)).length).toBe(0);
    expect((await exchange(record.address, "x".repeat(4097))).length).toBe(0);
    const oldTime = timestamp - 10000;
    const oldProof = createHmac("sha256", Buffer.from(record.key, "hex"))
      .update(`${nonce}:test-instance:${oldTime}`)
      .digest("hex");
    expect(
      (
        await exchange(
          record.address,
          JSON.stringify({ nonce, timestamp: oldTime, proof: oldProof }),
        )
      ).length,
    ).toBe(0);
    expect(entries).toBe(1);
  }, 20000);

  it("serializes concurrent launches and waits for its own instance to be ready", async () => {
    const data = await directory();
    const launch = async () => {
      const result = await LocalInstance.acquire(data, "test-instance");
      if (typeof result === "string") return "reopened";
      owners.push(result);
      await result.serve(() => "concurrent-entry");
      return "owner";
    };
    expect((await Promise.all([launch(), launch()])).sort()).toEqual(["owner", "reopened"]);
  }, 20000);

  it("rejects unsafe permissions without repairing existing directories", async () => {
    const data = await directory();
    const instance = await owner(data);
    await instance.close();
    const privatePath = path.join(data, ".companion-control");
    if (process.platform === "win32") {
      await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
$privateInfo = New-Object System.IO.DirectoryInfo($env:AGENTS_HUB_TEST_PRIVATE_PATH)
$privateAcl = $privateInfo.GetAccessControl()
$publicSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$publicRule = New-Object System.Security.AccessControl.FileSystemAccessRule($publicSid, 'ReadAndExecute', 'Allow')
$privateAcl.AddAccessRule($publicRule)
$privateInfo.SetAccessControl($privateAcl)
`,
        ],
        { windowsHide: true, env: { ...process.env, AGENTS_HUB_TEST_PRIVATE_PATH: privatePath } },
      );
    } else await chmod(privatePath, 0o755);
    await expect(LocalInstance.acquire(data, "test-instance")).rejects.toThrow(/permissions/);
    if (process.platform !== "win32") expect((await stat(privatePath)).mode & 0o777).toBe(0o755);
    expect(
      await stat(path.join(privatePath, "instance.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }, 20000);
});
