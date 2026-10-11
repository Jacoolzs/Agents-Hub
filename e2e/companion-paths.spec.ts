import { type ChildProcess, fork } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("compiled companion keeps data across cwd changes without writing installed resources", async ({
  playwright,
}) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agents-hub paths "));
  const resources = path.join(temporary, "installed resources");
  const data = path.join(temporary, "user data");
  const otherCwd = path.join(temporary, "other working directory");
  const script = path.resolve("apps/hub-server/dist/companion.js");
  const origin = "http://127.0.0.1:8801";
  let child: ChildProcess | undefined;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const processToStop = child;
    const exited = new Promise<void>((resolve) => processToStop.once("exit", () => resolve()));
    if (processToStop.connected) processToStop.send({ type: "shutdown" });
    const timer = setTimeout(() => processToStop.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  async function launch(cwd: string, secondary = false) {
    const launched = fork(script, [], {
      cwd,
      env: {
        ...process.env,
        AGENTS_HUB_RESOURCE_DIR: resources,
        AGENTS_HUB_DATA_DIR: data,
        DATABASE_URL: "nested/persistent.sqlite",
        PORT: "8800",
        LOCAL_CONTROL_PORT: "8801",
        AGENTS_HUB_NO_BROWSER: "1",
        LOG_LEVEL: "fatal",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    if (!secondary) child = launched;
    launched.stdout?.resume();
    launched.stderr?.resume();
    const exited = new Promise<number | null>((resolve) => launched.once("exit", resolve));
    const entry = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Companion not ready")), 10000);
      launched.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Companion exited"));
      });
      launched.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Companion spawn failed"));
      });
      launched.on("message", (message) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "ready" &&
          "url" in message &&
          typeof message.url === "string"
        ) {
          clearTimeout(timer);
          expect("reopened" in message && message.reopened).toBe(secondary);
          resolve(message.url);
        }
      });
    });
    if (secondary) expect(await exited).toBe(0);
    const client = await playwright.request.newContext({ extraHTTPHeaders: { origin } });
    try {
      const secret = new URLSearchParams(new URL(entry).hash.slice(1)).get("local-control");
      expect(
        (await client.post(`${origin}/local-api/bootstrap`, { data: { secret } })).status(),
      ).toBe(200);
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }
  try {
    await mkdir(otherCwd, { recursive: true });
    await cp(path.resolve("apps/web/dist"), path.join(resources, "apps/web/dist"), {
      recursive: true,
    });
    const first = await launch(temporary);
    try {
      expect(
        (
          await first.post(`${origin}/local-api/workspaces`, {
            data: {
              name: "Persistent team",
              person: { kind: "new", username: "persistent-host" },
            },
          })
        ).status(),
      ).toBe(200);
      expect((await first.get(`${origin}/`)).status()).toBe(200);
      expect((await first.post(`${origin}/local-api/runtime/start`)).status()).toBe(200);
      expect((await first.post(`${origin}/local-api/logout`)).status()).toBe(200);
      expect((await first.get(`${origin}/local-api/snapshot`)).status()).toBe(401);
      const reopened = await launch(otherCwd, true);
      try {
        const snapshot = await (await reopened.get(`${origin}/local-api/snapshot`)).json();
        expect(snapshot.runtime.hub).toBe("running");
        expect(snapshot.projects).toHaveLength(1);
        expect(child?.exitCode).toBeNull();
      } finally {
        await reopened.dispose();
      }
    } finally {
      await first.dispose();
    }
    await stop();
    expect((await stat(path.join(data, "nested/persistent.sqlite"))).size).toBeGreaterThan(0);
    const second = await launch(otherCwd);
    try {
      const snapshot = await (await second.get(`${origin}/local-api/snapshot`)).json();
      expect(snapshot.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Persistent team" })]),
      );
      expect(snapshot.users).toEqual(
        expect.arrayContaining([expect.objectContaining({ username: "persistent-host" })]),
      );
      expect(snapshot.accesses).toHaveLength(0);
      expect(snapshot.runtime.hub).toBe("stopped");
      expect(await readdir(resources)).toEqual(["apps"]);
      expect(await readdir(otherCwd)).toEqual([]);
      expect(await readdir(temporary)).toEqual(
        expect.arrayContaining(["installed resources", "user data", "other working directory"]),
      );
      expect(await readdir(temporary)).toHaveLength(3);
    } finally {
      await second.dispose();
    }
    const file = path.join(data, ".companion-control/instance.json");
    const beforeCrash = JSON.parse(await readFile(file, "utf8"));
    const crashed = child;
    if (!crashed) throw new Error("Missing own companion process");
    const exited = new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
    crashed.kill("SIGKILL");
    await exited;
    // No clean shutdown: OS releases ownership; persistent user data stays intact.
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(beforeCrash));
    const recovered = await launch(temporary);
    try {
      const afterCrash = JSON.parse(await readFile(file, "utf8"));
      expect(afterCrash.version).toBe(2);
      expect(afterCrash.key === beforeCrash.key).toBe(false);
      expect(afterCrash.address === beforeCrash.address).toBe(false);
      const snapshot = await (await recovered.get(`${origin}/local-api/snapshot`)).json();
      expect(snapshot.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Persistent team" })]),
      );
      expect(snapshot.users).toEqual(
        expect.arrayContaining([expect.objectContaining({ username: "persistent-host" })]),
      );
      expect(snapshot.runtime.hub).toBe("stopped");
    } finally {
      await recovered.dispose();
    }
  } finally {
    await stop();
    // Only this test's newly-created OS temporary directory is removed.
    if (
      path.dirname(temporary) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("agents-hub paths ")
    )
      await rm(temporary, { recursive: true, force: true });
  }
});
