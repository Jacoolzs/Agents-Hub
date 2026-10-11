import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  absolute,
  completedInstallation,
  installPackage,
  installationRoot,
  packageDetails,
} from "./install.mjs";
import { createShortcuts } from "./shortcuts.mjs";

export function createInstallation(sourceInput, launchEnv, env = process.env) {
  const source = absolute(sourceInput);
  const base = installationRoot(env);
  const data = absolute(launchEnv.AGENTS_HUB_DATA_DIR);
  async function describe() {
    const { bytes, identifier } = await packageDetails(source);
    const destination = path.join(base, "versions", identifier);
    let state = "ready";
    try {
      await lstat(destination);
      try {
        await completedInstallation(destination, bytes, false);
        state = "installed";
      } catch {
        state = "partial";
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { state, destination, data };
  }
  async function install(desktop) {
    const plan = await describe();
    if (plan.state === "partial")
      throw new Error(
        "Hay una copia incompleta o incompatible. Se conservó sin sobrescribir; revisa esa carpeta antes de instalar esta versión.",
      );
    let installed;
    if (plan.state === "installed") {
      const { bytes } = await packageDetails(source);
      installed = await completedInstallation(plan.destination, bytes);
    } else installed = await installPackage(source, base, data);
    const result = await createShortcuts(installed, base, launchEnv, desktop, env);
    return { installed: true, destination: installed, data, ...result };
  }
  return { describe, install };
}
