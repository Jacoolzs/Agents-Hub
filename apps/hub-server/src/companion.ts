import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@agents-hub/config";
import { createDatabase } from "./infrastructure/db/database.js";
import { buildLocalControl } from "./local/control-app.js";
import { LocalInstance } from "./local/instance.js";
import { companionPaths } from "./local/paths.js";
import { CompanionRuntime } from "./local/runtime.js";
import { LocalTunnel } from "./local/tunnel.js";

function openPanel(url: string, reopened = false) {
  if (process.connected) process.send?.({ type: "ready", url, reopened });
  if (process.env.AGENTS_HUB_NO_BROWSER === "1") return;
  const child =
    process.platform === "win32"
      ? spawn(
          "powershell.exe",
          ["-NoProfile", "-Command", `Start-Process -WindowStyle Hidden '${url}'`],
          { windowsHide: true, stdio: "ignore" },
        )
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
  (child as unknown as NodeJS.EventEmitter).once("error", () =>
    console.error(
      "No se pudo abrir el navegador. Reabre el compañero desde un escritorio disponible.",
    ),
  );
}

async function main() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const paths = companionPaths(root, process.env);
  const controlPort = Number(process.env.LOCAL_CONTROL_PORT ?? 8791);
  if (!Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535)
    throw new Error("LOCAL_CONTROL_PORT must be between 1024 and 65535");
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    WEB_STATIC_DIR: paths.web,
    DATABASE_URL: paths.database,
  });
  if (config.PORT === controlPort) throw new Error("Hub and control ports must be different");
  if (!config.WEB_STATIC_DIR) throw new Error("Static UI is required");
  await access(path.join(config.WEB_STATIC_DIR, "index.html"));
  const identity = createHash("sha256")
    .update(JSON.stringify([paths.data, config.DATABASE_URL, config.PORT, controlPort]))
    .digest("hex");
  const instance = await LocalInstance.acquire(paths.data, identity);
  if (typeof instance === "string") {
    const entry = new URL(instance);
    if (
      entry.origin !== `http://127.0.0.1:${controlPort}` ||
      entry.pathname !== "/" ||
      entry.search !== "?local-control=1" ||
      !/^#local-control=[A-Za-z0-9_-]{43}$/.test(entry.hash)
    )
      throw new Error("Invalid private entry");
    openPanel(instance, true);
    if (process.connected) process.disconnect?.();
    return;
  }
  try {
    await startCompanion(instance, paths, config, controlPort);
  } catch (error) {
    await instance.close();
    throw error;
  }
}

async function startCompanion(
  instance: LocalInstance,
  paths: ReturnType<typeof companionPaths>,
  config: ReturnType<typeof loadConfig>,
  controlPort: number,
) {
  const db = createDatabase(config.DATABASE_URL);
  let runtime: CompanionRuntime;
  try {
    runtime = await CompanionRuntime.create(config, db, new LocalTunnel(paths.data, config.PORT));
  } catch (error) {
    db.close();
    throw error;
  }
  const { app, bootstrapUrl, issueBootstrap } = buildLocalControl(
    runtime,
    `http://127.0.0.1:${controlPort}`,
    config.WEB_STATIC_DIR,
  );
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } finally {
      try {
        await runtime.stop();
      } finally {
        try {
          db.close();
        } finally {
          await instance.close();
          if (process.connected) process.disconnect?.();
        }
      }
    }
  }
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.on("message", (message) => {
    if (message && typeof message === "object" && "type" in message && message.type === "shutdown")
      void stop();
  });
  try {
    await app.listen({ host: "127.0.0.1", port: controlPort });
    await instance.serve(() => {
      if (stopping) throw new Error("Companion is stopping");
      return issueBootstrap();
    });
    openPanel(bootstrapUrl);
    console.log(
      "Agents-Hub: panel local abierto. Hub detenido hasta que pulses Iniciar. Cierra el compañero con Ctrl+C.",
    );
  } catch {
    console.error("El panel no pudo iniciarse. Comprueba que su puerto esté libre.");
    process.exitCode = 1;
    await stop();
  }
}
void main().catch(() => {
  console.error(
    "No se pudo preparar o reabrir el compañero. Comprueba build, configuración, carpeta de datos privada y puertos. No se tomó ninguna instancia ajena; los registros antiguos o incompatibles requieren revisión explícita.",
  );
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
