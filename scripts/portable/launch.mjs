import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function portableData(env = process.env, platform = process.platform, home = os.homedir()) {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA
      : (env.XDG_DATA_HOME ?? path.join(home, ".local", "share"));
  const result =
    env.AGENTS_HUB_DATA_DIR ??
    (base && path.join(base, platform === "win32" ? "Agents-Hub" : "agents-hub"));
  if (!result || !path.isAbsolute(result) || result.includes("\0"))
    throw new Error("La carpeta de datos debe ser absoluta y pertenecer al usuario.");
  if (process.platform === "win32" && /^[\\/]$/.test(path.parse(result).root))
    throw new Error("La carpeta de datos debe incluir la unidad.");
  return path.normalize(result);
}

export async function launchCompanion() {
  try {
    process.env.AGENTS_HUB_RESOURCE_DIR = fileURLToPath(new URL("../", import.meta.url));
    process.env.AGENTS_HUB_DATA_DIR = portableData();
    await import("../apps/hub-server/dist/companion.js");
  } catch {
    console.error("No se pudo abrir Agents-Hub. Revisa el paquete y la carpeta privada de datos.");
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await launchCompanion();
