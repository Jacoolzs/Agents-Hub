import { loadConfig } from "@agents-hub/config";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
    app.ctx.db.close();
    if (process.connected) process.disconnect?.();
  } catch {
    console.error("Hub shutdown failed");
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "shutdown")
    void shutdown();
});

async function start() {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info({ host: config.HOST, port: config.PORT }, "hub.started");
  } catch (err) {
    app.log.error({ err }, "hub.start.failed");
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
