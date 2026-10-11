import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("OS ownership survives concurrent recovery and crash before IPC readiness", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "ah-ownership-"));
  const processes: ChildProcess[] = [];
  function launch(beforeServe = false) {
    const child = fork(path.resolve("e2e/fixtures/private-instance.mjs"), [], {
      env: { ...process.env, AH_TEST_DATA: data, AH_TEST_BEFORE_SERVE: beforeServe ? "1" : "0" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    processes.push(child);
    return new Promise<{ child: ChildProcess; role: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test instance not ready")), 10000);
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Test instance exited before readiness"));
      });
      child.once("message", (message) => {
        clearTimeout(timer);
        if (!message || typeof message !== "object" || !("role" in message))
          return reject(new Error("Invalid test response"));
        resolve({ child, role: String(message.role) });
      });
    });
  }
  async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  try {
    const initial = await launch(true);
    expect(initial.role).toBe("owner");
    const file = path.join(data, ".companion-control/instance.json");
    const before = JSON.parse(await readFile(file, "utf8"));
    await kill(initial.child);
    const launches = await Promise.all([launch(), launch()]);
    expect(launches.map(({ role }) => role).sort()).toEqual(["owner", "reopened"]);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.version).toBe(2);
    expect(before.key === after.key).toBe(false);
    expect(before.address === after.address).toBe(false);
    const owner = launches.find(({ role }) => role === "owner");
    if (!owner) throw new Error("No owner elected");
    await kill(owner.child);
    expect((await launch()).role).toBe("owner");
  } finally {
    await Promise.all(processes.map(kill));
    if (
      path.dirname(data) === path.resolve(os.tmpdir()) &&
      path.basename(data).startsWith("ah-ownership-")
    )
      await rm(data, { recursive: true, force: true });
  }
});
