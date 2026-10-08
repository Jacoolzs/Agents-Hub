import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "2026.10.0";
const sha256 = "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c";
const executable = path.join(root, ".tools", `cloudflared-${version}.exe`);
const port = Number(process.env.PORT || 8787);
let tunnel;
let hub;
let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stop() {
  if (stopping) return;
  stopping = true;
  if (hub && hub.exitCode === null) {
    const exited = new Promise((resolve) => hub.once("exit", resolve));
    if (hub.connected) hub.send({ type: "shutdown" });
    await Promise.race([exited, sleep(5000)]);
    if (hub.exitCode === null) hub.kill();
  }
  if (tunnel && tunnel.exitCode === null) tunnel.kill();
  if (process.connected) process.disconnect();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.on("message", (message) => {
  if (message?.type === "shutdown") void stop();
});

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error(
      "This launcher targets Windows x64; use your cloudflared installation on other platforms.",
    );
  if (
    !existsSync(path.join(root, "apps/web/dist/index.html")) ||
    !existsSync(path.join(root, "apps/hub-server/dist/server.js"))
  )
    throw new Error("Run pnpm build first.");
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(new Error(`Port ${port} is already occupied. Stop the existing Hub before sharing.`)),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
  await mkdir(path.dirname(executable), { recursive: true });
  if (!existsSync(executable)) {
    console.log(`Downloading official cloudflared ${version} (portable)...`);
    const response = await fetch(
      `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok) throw new Error("cloudflared download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("cloudflared checksum mismatch");
    await writeFile(`${executable}.download`, bytes);
    await rename(`${executable}.download`, executable);
  }
  if (
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex") !== sha256
  )
    throw new Error("cloudflared checksum mismatch");
  const logDir = path.join(root, "logs");
  await mkdir(logDir, { recursive: true });
  const tunnelLog = createWriteStream(path.join(logDir, "tunnel.log"), { flags: "a" });
  const hubLog = createWriteStream(path.join(logDir, "hub.log"), { flags: "a" });
  tunnel = spawn(
    executable,
    ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  tunnel.once("error", () => {
    console.error("Tunnel could not start");
    process.exitCode = 1;
    void stop();
  });
  let url = "";
  let buffered = "";
  for (const stream of [tunnel.stdout, tunnel.stderr])
    stream.on("data", (bytes) => {
      tunnelLog.write(bytes);
      buffered = `${buffered}${bytes.toString()}`.slice(-8192);
      url ||= buffered.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] || "";
    });
  const deadline = Date.now() + 60000;
  while (!url && Date.now() < deadline && !stopping && tunnel.exitCode === null) await sleep(200);
  if (!url || stopping) throw new Error("Tunnel URL unavailable. See logs/tunnel.log.");
  hub = spawn(process.execPath, ["apps/hub-server/dist/server.js"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      CORS_ORIGINS: url,
      WEB_STATIC_DIR: path.join(root, "apps/web/dist"),
    },
  });
  for (const stream of [hub.stdout, hub.stderr]) stream.pipe(hubLog, { end: false });
  hub.once("error", () => {
    console.error("Hub could not start");
    process.exitCode = 1;
    void stop();
  });
  for (const child of [hub, tunnel])
    child.once("exit", (code) => {
      if (!stopping) {
        console.error("A sharing process stopped; shutting down both processes.");
        process.exitCode = code || 1;
        void stop();
      }
    });
  let ready = false;
  for (let i = 0; i < 50 && !stopping; i++) {
    try {
      ready = (
        await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1000) })
      ).ok;
    } catch {}
    if (ready) break;
    await sleep(200);
  }
  if (!ready) throw new Error("Hub failed readiness. See logs/hub.log.");
  console.log(
    `\nAgents-Hub: ${url}\nShare this URL and the project ID. Give each friend their personal token and a single-use invitation privately.\nKeep this terminal and PC running. Ctrl+C stops Hub and tunnel.\nLogs: logs/hub.log and logs/tunnel.log`,
  );
  if (process.connected) process.send({ type: "ready", url, port });
}
main().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
  await stop();
});
