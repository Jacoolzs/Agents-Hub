import { loadConfig } from "@agents-hub/config";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);

async function start() {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    console.log(`Hub Server running on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    console.error("Failed to start Hub Server", err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
