import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portableData } from "./launch.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};
export function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))
    throw new Error("Se requiere una carpeta absoluta dedicada.");
  const result = path.normalize(value);
  if (process.platform === "win32" && /^[\\/]$/.test(path.parse(result).root))
    throw new Error("La carpeta debe incluir la unidad.");
  return result;
}
export function installationRoot(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA
      : (env.XDG_DATA_HOME ?? path.join(home, ".local", "share"));
  if (!base) throw new Error("No se encontró la carpeta del usuario.");
  return absolute(
    path.join(absolute(base), platform === "win32" ? "Programs/Agents-Hub" : "agents-hub-program"),
  );
}
// No traversing links/junctions in trusted local package or installation paths.
export async function directoryChain(directory, create = false) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Carpeta no regular o enlace rechazado.");
  }
}
async function eachFile(files, task) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      while (next < files.length) await task(files[next++]);
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
async function verify(directory, manifest, installed = false) {
  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const actual = [];
  async function walk(current) {
    for (const info of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, info.name);
      if (info.isSymbolicLink()) throw new Error("Enlace rechazado en el paquete.");
      if (info.isDirectory()) await walk(file);
      else if (info.isFile()) {
        const relative = path.relative(directory, file).split(path.sep).join("/");
        if (relative !== "artifact.json" && !(installed && relative === "installation.json"))
          actual.push(relative);
      } else throw new Error("Archivo no regular en el paquete.");
    }
  }
  await walk(directory);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file)))
    throw new Error("El inventario no coincide con el paquete.");
  await eachFile(manifest.files, async (file) => {
    if (digest(await readFile(path.join(directory, file.path))) !== file.sha256)
      throw new Error("Archivo alterado o incompleto.");
  });
}
function manifestInput(bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.format !== 1 ||
    manifest.preview !== true ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 20000
  )
    throw new Error("Paquete incompatible con este equipo.");
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.path === "artifact.json" ||
      file.path === "installation.json"
    )
      throw new Error("Inventario inválido.");
    for (const part of file.path.split("/"))
      if (
        !part ||
        part === "." ||
        part === ".." ||
        /[\\<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)
      )
        throw new Error("Ruta no portable en el inventario.");
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("Ruta duplicada en el inventario.");
    seen.add(key);
  }
  for (const required of [
    "scripts/launch.mjs",
    "apps/web/dist/index.html",
    "apps/hub-server/dist/companion.js",
    "packages/mcp-server/dist/main.js",
    process.platform === "win32" ? "runtime/node.exe" : "runtime/node",
  ])
    if (!manifest.files.some((file) => file.path === required))
      throw new Error("Paquete incompleto.");
  return manifest;
}

export async function packageDetails(sourceInput) {
  const source = absolute(sourceInput);
  await directoryChain(source);
  const info = await lstat(path.join(source, "artifact.json"));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
    throw new Error("Manifest inválido.");
  const bytes = await readFile(path.join(source, "artifact.json"));
  return { bytes, manifest: manifestInput(bytes), identifier: digest(bytes) };
}
export async function completedInstallation(directory, bytes, verifyFiles = true) {
  await directoryChain(directory);
  const marker = path.join(directory, "installation.json");
  const info = await lstat(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512)
    throw new Error("Copia incompleta.");
  const parsed = JSON.parse(await readFile(marker, "utf8"));
  if (
    Object.keys(parsed).length !== 2 ||
    parsed.format !== 1 ||
    parsed.artifactSha256 !== digest(bytes)
  )
    throw new Error("Copia incompatible.");
  const installed = await packageDetails(directory);
  if (!installed.bytes.equals(bytes)) throw new Error("Manifest instalado distinto.");
  if (verifyFiles) await verify(directory, installed.manifest, true);
  return directory;
}

export async function installPackage(
  sourceInput,
  baseInput = installationRoot(),
  dataInput = portableData(),
) {
  if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
    throw new Error("Este preview sólo admite Windows/Linux x64.");
  const source = absolute(sourceInput);
  const base = absolute(baseInput);
  const data = absolute(dataInput);
  if (
    base === path.parse(base).root ||
    base === os.homedir() ||
    inside(source, base) ||
    inside(base, source) ||
    inside(data, base) ||
    inside(base, data)
  )
    throw new Error("Recursos, origen y datos deben permanecer separados.");
  const { bytes, manifest, identifier } = await packageDetails(source);
  try {
    await directoryChain(data);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await verify(source, manifest);
  await directoryChain(path.join(base, "versions"), true);
  const installed = path.join(base, "versions", identifier);
  // Exclusive reservation also fences concurrent installations of the same artifact.
  await mkdir(installed, { mode: 0o700 });
  const directories = new Set();
  for (const file of manifest.files) {
    let current = installed;
    for (const part of file.path.split("/").slice(0, -1)) {
      current = path.join(current, part);
      directories.add(current);
    }
  }
  // All these descendants are new inside our exclusively reserved version.
  // Parent-first exclusive mkdir rejects any unexpected pre-existing entry.
  for (const directory of [...directories].sort()) await mkdir(directory, { mode: 0o700 });
  await eachFile(manifest.files, async (file) => {
    const origin = path.join(source, file.path);
    const target = path.join(installed, file.path);
    await copyFile(origin, target, constants.COPYFILE_EXCL);
    await chmod(target, (await lstat(origin)).mode & 0o755);
  });
  await writeFile(path.join(installed, "artifact.json"), bytes, { flag: "wx", mode: 0o600 });
  await verify(installed, manifest);
  await writeFile(
    path.join(installed, "installation.json"),
    `${JSON.stringify({ format: 1, artifactSha256: identifier })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return installed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--confirm")
      throw new Error("Confirmación requerida.");
    const installed = await installPackage(fileURLToPath(new URL("../", import.meta.url)));
    console.log(
      `Recursos instalados: ${installed}\nDatos conservados. Abre el compañero y confirma la instalación en el panel para crear accesos directos.`,
    );
  } catch {
    console.error(
      "No se completó la instalación. Revisa el paquete, rutas y permisos. Versiones existentes o parciales no se sobrescriben ni se borran.",
    );
    process.exitCode = 1;
  }
}
