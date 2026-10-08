import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../apps/hub-server/dist/app.js";

const root = process.cwd();
const require = createRequire(path.join(root, "apps/hub-server/package.json"));
const WebSocket = createRequire(require.resolve("@fastify/websocket"))("ws");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright");
const directory = mkdtempSync(path.join(os.tmpdir(), "agents-hub-share-"));
const database = path.join(directory, "test.sqlite");
const seed = buildApp({ DATABASE_URL: database });
const alice = crypto.randomUUID();
const bob = crypto.randomUUID();
const project = seed.ctx.projectService.createProject("Public tunnel acceptance", alice).project
  .project_id;
seed.ctx.db
  .prepare("INSERT INTO users VALUES (?, ?, ?)")
  .run(bob, "smoke-bob", new Date().toISOString());
const invite = seed.ctx.membershipService.createInvitation(alice, project, {}, crypto.randomUUID());
seed.ctx.membershipService.acceptInvitation(bob, project, invite.token, crypto.randomUUID());
const aliceToken = seed.ctx.authService.createToken(alice, "agents-hub");
const bobToken = seed.ctx.authService.createToken(bob, "agents-hub");
await seed.close();
seed.ctx.db.close();
const launcher = fork(path.join(root, "scripts/share.mjs"), [], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: { ...process.env, PORT: "8790", DATABASE_URL: database },
});
let output = "";
for (const stream of [launcher.stdout, launcher.stderr])
  stream.on("data", (bytes) => {
    output = `${output}${bytes}`.slice(-2000);
  });
const ended = new Promise((resolve) => launcher.once("exit", resolve));
let socket;
let browser;
try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tunnel startup timed out")), 180000);
    launcher.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    launcher.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Launcher stopped: ${output}`));
    });
  });
  const url = ready.url;
  const rootPath = `/v1/projects/${project}`;
  console.log("Temporary HTTPS tunnel ready; checking public HTTP, WSS and browser...");
  async function request(token, route, method, body) {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(
      response.status,
      method === "POST" &&
        ["/sessions", "/messages", "/ws-ticket"].some((suffix) => route.endsWith(suffix))
        ? 201
        : 200,
    );
    return (await response.json()).data;
  }
  let health = false;
  for (let i = 0; i < 15; i++) {
    try {
      health = (await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(10000) })).ok;
    } catch {}
    if (health) break;
    await sleep(2000);
  }
  assert(health, "Public HTTPS health unavailable");
  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert(html.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  assert((await html.text()).includes("/assets/"));
  const a = await request(aliceToken, `${rootPath}/sessions`, "POST", { agent_id: "smoke-alice" });
  const b = await request(bobToken, `${rootPath}/sessions`, "POST", { agent_id: "smoke-bob" });
  const ticket = await request(bobToken, `${rootPath}/ws-ticket`, "POST", {
    session_id: b.session_id,
  });
  const connected = new Promise((resolve, reject) => {
    socket = new WebSocket(
      `${url.replace("https:", "wss:")}${rootPath}/events?session_id=${b.session_id}&ticket=${ticket.ticket}`,
      { origin: url, handshakeTimeout: 20000 },
    );
    socket.once("error", reject);
    socket.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "connected") resolve();
    });
  });
  await Promise.race([
    connected,
    sleep(20000).then(() => {
      throw new Error("WSS handshake timed out");
    }),
  ]);
  const received = new Promise((resolve) =>
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "event" && frame.data.payload.body === "Public TLS directed message")
        resolve();
    }),
  );
  await request(aliceToken, `${rootPath}/messages`, "POST", {
    session_id: a.session_id,
    body: "Public TLS directed message",
    recipient_agent_ids: ["smoke-bob"],
  });
  await Promise.race([
    received,
    sleep(20000).then(() => {
      throw new Error("WSS delivery timed out");
    }),
  ]);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  assert.equal(await page.locator("#hub-url").inputValue(), url);
  await page.fill("#auth-token", bobToken);
  await page.fill("#project-id", project);
  await page.fill("#agent-id", "smoke-browser");
  await page.click("button[type=submit]");
  await page.getByText("Conectado (WS)").waitFor({ timeout: 20000 });
  const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  assert(!leaked.includes(bobToken));
  const logs = readFileSync(path.join(root, "logs/hub.log"), "utf8");
  for (const secret of [aliceToken, bobToken, invite.token, ticket.ticket])
    assert(!logs.includes(secret), "Secret leaked in Hub logs");
  const closed = new Promise((resolve) => socket.once("close", resolve));
  launcher.send({ type: "shutdown" });
  const closeCode = await Promise.race([
    closed,
    sleep(7000).then(() => {
      throw new Error("WS did not close on shutdown");
    }),
  ]);
  assert.equal(closeCode, 1001);
  assert.equal(
    await Promise.race([
      ended,
      sleep(10000).then(() => {
        throw new Error("Launcher did not shut down");
      }),
    ]),
    0,
  );
  const restored = buildApp({ DATABASE_URL: database });
  assert.equal(restored.ctx.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(restored.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
  await restored.close();
  restored.ctx.db.close();
  const report = {
    date: new Date().toISOString(),
    transport: "Cloudflare Quick Tunnel HTTPS/WSS with publicly trusted TLS",
    static_dashboard: "PASS",
    two_user_directed_delivery: "PASS",
    browser_ticket_authentication: "PASS",
    logs_secret_redaction: "PASS",
    supervisor_shutdown: "PASS",
    ws_close_code: closeCode,
    sqlite_integrity_restart: "PASS",
    ephemeral_database: true,
  };
  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync("docs/evidence/share-smoke.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  socket?.terminate();
  if (launcher.connected) launcher.send({ type: "shutdown" });
  await Promise.race([ended, sleep(7000)]);
  if (launcher.exitCode === null) launcher.kill();
}
