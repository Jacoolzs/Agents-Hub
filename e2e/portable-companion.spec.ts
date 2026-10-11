import { type ChildProcess, execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const sdk = createRequire(path.resolve("packages/mcp-server/package.json"));
const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = sdk("@modelcontextprotocol/sdk/client/stdio.js");

test("portable artifact preserves dependency inventory and every file checksum", async () => {
  test.skip(!process.env.AGENTS_HUB_PORTABLE_ARTIFACT, "Portable preview not built");
  test.setTimeout(60000);
  const installed = path.resolve(process.env.AGENTS_HUB_PORTABLE_ARTIFACT as string);
  const manifest = JSON.parse(await readFile(path.join(installed, "artifact.json"), "utf8")) as {
    runtime: { version: string };
    packages: Array<{ name: string }>;
    files: Array<{ path: string; sha256: string }>;
  };
  expect(manifest.runtime.version).toBe("24.21.0");
  expect(manifest.packages.some(({ name }) => name === "@modelcontextprotocol/sdk")).toBe(true);
  expect(
    manifest.packages.some(({ name }) => ["typescript", "vitest", "pnpm"].includes(name)),
  ).toBe(false);
  expect(manifest.files.some(({ path: file }) => /mcp-orlando|\.sqlite$|^data\//.test(file))).toBe(
    false,
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < manifest.files.length) {
        const file = manifest.files[next++];
        const resolved = path.resolve(installed, file.path);
        expect(path.relative(installed, resolved).startsWith("..")).toBe(false);
        expect(
          createHash("sha256")
            .update(await readFile(resolved))
            .digest("hex"),
        ).toBe(file.sha256);
      }
    }),
  );
});

test("portable runtime runs Hub and MCP outside checkout, reopens and preserves data after relocation", async ({
  playwright,
}) => {
  test.skip(
    !process.env.AGENTS_HUB_PORTABLE_ARTIFACT,
    "Build the portable preview and set AGENTS_HUB_PORTABLE_ARTIFACT",
  );
  test.setTimeout(60000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ah-portable-"));
  let installed = path.join(temporary, "installed resources with spaces");
  const data = path.join(temporary, "user data");
  const cwd = path.join(temporary, "unrelated cwd");
  const origin = "http://127.0.0.1:8811";
  const processes: ChildProcess[] = [];
  const closures = new WeakMap<ChildProcess, Promise<void>>();
  const contexts: Array<{ dispose(): Promise<void> }> = [];
  async function stop(child: ChildProcess, abrupt = false) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await closures.get(child);
      return;
    }
    const closed = closures.get(child);
    if (abrupt) child.kill("SIGKILL");
    else if (child.connected) child.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
  }
  async function launch(secondary = false) {
    const child = fork(path.join(installed, "scripts/launch.mjs"), [], {
      execPath: path.join(installed, "runtime", process.platform === "win32" ? "node.exe" : "node"),
      cwd,
      env: {
        ...process.env,
        NODE_PATH: "",
        NODE_OPTIONS: "",
        AGENTS_HUB_DATA_DIR: data,
        DATABASE_URL: "portable.sqlite",
        PORT: "8810",
        LOCAL_CONTROL_PORT: "8811",
        AGENTS_HUB_NO_BROWSER: "1",
        LOG_LEVEL: "fatal",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    processes.push(child);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    closures.set(child, closed);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const entry = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Portable companion not ready")), 10000);
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Portable companion exited"));
      });
      child.once("message", (message) => {
        clearTimeout(timer);
        if (
          !message ||
          typeof message !== "object" ||
          !("url" in message) ||
          typeof message.url !== "string"
        )
          return reject(new Error("Invalid portable readiness"));
        expect("reopened" in message && message.reopened).toBe(secondary);
        resolve(message.url);
      });
    });
    if (secondary) {
      expect(await exited).toBe(0);
      await closed;
    }
    const client = await playwright.request.newContext({ extraHTTPHeaders: { origin } });
    contexts.push(client);
    const secret = new URLSearchParams(new URL(entry).hash.slice(1)).get("local-control");
    expect(
      (await client.post(`${origin}/local-api/bootstrap`, { data: { secret } })).status(),
    ).toBe(200);
    return { child, client };
  }
  try {
    await mkdir(cwd);
    await test.step("install with bundled runtime into fake user profile", async () => {
      const source = path.resolve(process.env.AGENTS_HUB_PORTABLE_ARTIFACT as string);
      const fakeUser = path.join(temporary, "fake user profile");
      await promisify(execFile)(
        path.join(source, "runtime", process.platform === "win32" ? "node.exe" : "node"),
        [path.join(source, "scripts/install.mjs"), "--confirm"],
        {
          cwd,
          windowsHide: true,
          timeout: 60000,
          env: {
            ...process.env,
            NODE_PATH: "",
            NODE_OPTIONS: "",
            LOCALAPPDATA: fakeUser,
            XDG_DATA_HOME: fakeUser,
            AGENTS_HUB_DATA_DIR: data,
          },
        },
      );
      const identifier = createHash("sha256")
        .update(await readFile(path.join(source, "artifact.json")))
        .digest("hex");
      installed = path.join(
        fakeUser,
        process.platform === "win32" ? "Programs/Agents-Hub" : "agents-hub-program",
        "versions",
        identifier,
      );
      expect(JSON.parse(await readFile(path.join(installed, "installation.json"), "utf8"))).toEqual(
        { format: 1, artifactSha256: identifier },
      );
    });
    const first = await test.step("launch bundled runtime", () => launch());
    const workspaceReply = await first.client.post(`${origin}/local-api/workspaces`, {
      data: { name: "Portable team", person: { kind: "new", username: "portable-host" } },
    });
    expect(workspaceReply.status()).toBe(200);
    const workspace = await workspaceReply.json();
    expect((await first.client.post(`${origin}/local-api/runtime/start`)).status()).toBe(200);
    const access = await first.client.post(
      `${origin}/local-api/users/${workspace.user.user_id}/accesses`,
      { data: { ttl_seconds: 3600, project_id: workspace.project.project_id } },
    );
    expect(access.status()).toBe(200);
    const credential = await access.json();
    const mcp = new Client({ name: "portable-test", version: "1.0.0" }, { capabilities: {} });
    let mcpClosed: Promise<void> | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: path.join(
          installed,
          "runtime",
          process.platform === "win32" ? "node.exe" : "node",
        ),
        args: [path.join(installed, "packages/mcp-server/dist/main.js")],
        cwd,
        env: {
          ...env,
          NODE_PATH: "",
          NODE_OPTIONS: "",
          NODE_ENV: "production",
          AGENTS_HUB_URL: "http://127.0.0.1:8810",
          AGENTS_HUB_TOKEN: credential.token,
        },
        stderr: "pipe",
      });
      // SDK close() can return after its timeout/exit before the native stdio close event.
      mcpClosed = new Promise<void>((resolve) => {
        transport.onclose = resolve;
      });
      await mcp.connect(transport);
      const joined = await mcp.callTool({
        name: "join_project",
        arguments: { project_id: workspace.project.project_id, agent_name: "portable-agent" },
      });
      expect(joined.isError).not.toBe(true);
      const status = await mcp.callTool({ name: "get_team_status", arguments: {} });
      expect(status.isError).not.toBe(true);
    } finally {
      await mcp.close();
      await mcpClosed;
    }
    const reopened = await launch(true);
    expect(
      (await (await reopened.client.get(`${origin}/local-api/snapshot`)).json()).runtime.hub,
    ).toBe("running");
    await stop(first.child, true);
    const recovered = await launch();
    expect(
      (await (await recovered.client.get(`${origin}/local-api/snapshot`)).json()).projects,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Portable team" })]));
    expect(
      (
        await recovered.client.post(`${origin}/local-api/companion/shutdown`, {
          data: { confirm: true },
        })
      ).status(),
    ).toBe(202);
    await expect.poll(() => recovered.child.exitCode, { timeout: 5000 }).toBe(0);
    await stop(recovered.child); // Wait for close/IPC, not merely exitCode, before moving resources.
    const updated = path.join(temporary, "relocated version");
    await rename(installed, updated);
    installed = updated;
    const relocated = await launch();
    const snapshot = await (await relocated.client.get(`${origin}/local-api/snapshot`)).json();
    expect(snapshot.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Portable team" })]),
    );
    expect(snapshot.users).toEqual(
      expect.arrayContaining([expect.objectContaining({ username: "portable-host" })]),
    );
    expect(snapshot.runtime.hub).toBe("stopped");
  } finally {
    await Promise.all(contexts.map((client) => client.dispose()));
    await Promise.all(processes.map((child) => stop(child)));
    if (
      path.dirname(temporary) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("ah-portable-")
    )
      await rm(temporary, { recursive: true, force: true });
  }
});
