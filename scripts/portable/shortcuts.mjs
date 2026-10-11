import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { absolute, directoryChain } from "./install.mjs";

const run = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function safePath(value) {
  const result = absolute(value);
  if ([...result].some((character) => character.charCodeAt(0) < 32) || result.includes("="))
    throw new Error("Ruta no admitida por el acceso directo.");
  return result;
}
const stringValue = (value) =>
  value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
export function desktopEntry(node, entry, label) {
  const quote = (value) =>
    `"${safePath(value)
      .replace(/[\\"$`]/g, (character) => `\\${character}`)
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "%%")}"`;
  return `[Desktop Entry]\nType=Application\nName=${label}\nComment=Panel privado de Agents-Hub\nExec=${quote(node)} ${quote(entry)}\nTerminal=true\nCategories=Development;\n`;
}
export async function shortcutDirectories(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  let menu = env.AGENTS_HUB_MENU_DIR;
  let desktop = env.AGENTS_HUB_DESKTOP_DIR;
  if (platform === "win32" && (!menu || !desktop)) {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$shell = New-Object -ComObject WScript.Shell; @{menu=$shell.SpecialFolders.Item('Programs');desktop=$shell.SpecialFolders.Item('Desktop')} | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const folders = JSON.parse(result.stdout.trim());
    menu ??= folders.menu;
    desktop ??= folders.desktop;
  } else if (platform === "linux") {
    menu ??= path.join(env.XDG_DATA_HOME ?? path.join(home, ".local/share"), "applications");
    if (!desktop) {
      try {
        desktop = (await run("xdg-user-dir", ["DESKTOP"], { env, timeout: 5000 })).stdout.trim();
      } catch {
        desktop = path.join(home, "Desktop");
      }
    }
  }
  return { menu: safePath(menu), desktop: safePath(desktop) };
}
async function existing(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Acceso existente no regular.");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function immutableText(file, text, mode = 0o600) {
  await directoryChain(path.dirname(file), true);
  if (await existing(file)) {
    if ((await readFile(file, "utf8")) !== text)
      throw new Error("Hay un archivo ajeno; no se reemplazó.");
    return;
  }
  try {
    await writeFile(file, text, { flag: "wx", mode });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      !(await existing(file)) ||
      (await readFile(file, "utf8")) !== text
    )
      throw error;
  }
}
async function windowsShortcut(file, node, entry, label) {
  const args = `"${entry}"`;
  const env = {
    ...process.env,
    AH_LINK_FILE: file,
    AH_LINK_NODE: node,
    AH_LINK_ARGS: args,
    AH_LINK_LABEL: label,
    AH_LINK_CWD: path.dirname(entry),
  };
  const inspect = async (target) => {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:AH_LINK_FILE); if ($s.TargetPath -ne $env:AH_LINK_NODE -or $s.Arguments -cne $env:AH_LINK_ARGS -or $s.Description -cne $env:AH_LINK_LABEL -or $s.WorkingDirectory -ne $env:AH_LINK_CWD -or $s.WindowStyle -ne 1) {throw 'Foreign shortcut'}",
      ],
      { env: { ...env, AH_LINK_FILE: target }, windowsHide: true, timeout: 10000 },
    );
    return result;
  };
  await directoryChain(path.dirname(file), true);
  if (await existing(file)) {
    await inspect(file);
    return;
  }
  const temporary = path.join(path.dirname(file), `.ah-shortcut-${randomUUID()}.lnk`);
  let failure;
  try {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:AH_LINK_FILE); $s.TargetPath=$env:AH_LINK_NODE; $s.Arguments=$env:AH_LINK_ARGS; $s.Description=$env:AH_LINK_LABEL; $s.WorkingDirectory=$env:AH_LINK_CWD; $s.WindowStyle=1; $s.Save()",
      ],
      { env: { ...env, AH_LINK_FILE: temporary }, windowsHide: true, timeout: 10000 },
    );
    await inspect(temporary);
    try {
      await link(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST" || !(await existing(file))) throw error;
      await inspect(file);
    }
    await inspect(file);
  } catch (error) {
    failure = error;
  }
  try {
    await unlink(temporary);
  } catch (error) {
    if (error.code !== "ENOENT") failure ??= error;
  }
  if (failure) throw failure;
}
export async function createShortcuts(installed, base, launchEnv, desktop, env = process.env) {
  const node = safePath(
    path.join(installed, "runtime", process.platform === "win32" ? "node.exe" : "node"),
  );
  const configuration = {
    AGENTS_HUB_DATA_DIR: safePath(launchEnv.AGENTS_HUB_DATA_DIR),
    DATABASE_URL: safePath(launchEnv.DATABASE_URL),
    PORT: String(launchEnv.PORT),
    LOCAL_CONTROL_PORT: String(launchEnv.LOCAL_CONTROL_PORT),
  };
  const script = `// Agents-Hub: entrada local sin credenciales.\nObject.assign(process.env, ${JSON.stringify(configuration)});\nconst { launchCompanion } = await import(${JSON.stringify(pathToFileURL(path.join(installed, "scripts/launch.mjs")).href)});\nawait launchCompanion();\n`;
  const identity = hash(script);
  const entry = path.join(base, "entries", identity, "open.mjs");
  await immutableText(entry, script);
  const label = `Agents-Hub preview ${path.basename(installed).slice(0, 12)} (${identity.slice(0, 6)})`;
  const folders = await shortcutDirectories(env);
  const shortcuts = [];
  for (const folder of [folders.menu, ...(desktop ? [folders.desktop] : [])]) {
    const file = path.join(
      folder,
      process.platform === "win32" ? `${label}.lnk` : `agents-hub-${identity}.desktop`,
    );
    if (process.platform === "win32") await windowsShortcut(file, node, entry, label);
    else await immutableText(file, desktopEntry(node, entry, stringValue(label)), 0o755);
    shortcuts.push(file);
  }
  return { label, shortcuts };
}
