import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@agents-hub/config";
import { createDatabase } from "./infrastructure/db/database.js";
import { buildLocalControl } from "./local/control-app.js";
import { CompanionRuntime } from "./local/runtime.js";
import { LocalTunnel } from "./local/tunnel.js";

async function main() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const controlPort = Number(process.env.LOCAL_CONTROL_PORT ?? 8791);
  if (!Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535)
    throw new Error("LOCAL_CONTROL_PORT must be between 1024 and 65535");
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    WEB_STATIC_DIR: path.join(root, "apps/web/dist"),
  });
  if (config.PORT === controlPort) throw new Error("Hub and control ports must be different");
  if (!config.WEB_STATIC_DIR) throw new Error("Static UI is required");
  await access(path.join(config.WEB_STATIC_DIR, "index.html"));
  const db = createDatabase(config.DATABASE_URL);
  const runtime = await CompanionRuntime.create(config, db, new LocalTunnel(root, config.PORT));
  const { app, bootstrapUrl } = buildLocalControl(
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
        db.close();
        if (process.connected) process.disconnect?.();
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
    // IPC is used by isolated verification and future launchers; bootstrap never enters process logs.
    if (process.connected) process.send?.({ type: "ready", url: bootstrapUrl });
    if (process.env.AGENTS_HUB_NO_BROWSER !== "1") {
      const child =
        process.platform === "win32"
          ? spawn(
              "powershell.exe",
              ["-NoProfile", "-Command", `Start-Process -WindowStyle Hidden '${bootstrapUrl}'`],
              { windowsHide: true, stdio: "ignore" },
            )
          : spawn(process.platform === "darwin" ? "open" : "xdg-open", [bootstrapUrl], {
              stdio: "ignore",
            });
      (child as unknown as NodeJS.EventEmitter).once("error", () =>
        console.error(
          "No se pudo abrir el navegador. Reabre el compañero desde un escritorio disponible.",
        ),
      );
    }
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
    "No se pudo preparar el compañero. Ejecuta pnpm build y comprueba la configuración, permisos y puertos distintos del Hub y panel (1024–65535).",
  );
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
