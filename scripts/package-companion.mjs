import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
export const runtimeVersion = "24.21.0";
export const runtimeArchives = {
  win32: {
    name: `node-v${runtimeVersion}-win-x64.zip`,
    sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  },
  linux: {
    name: `node-v${runtimeVersion}-linux-x64.tar.gz`,
    sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
  },
};
export function verifiedRuntime(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Runtime checksum mismatch; nothing extracted");
}
export function outputDirectory(value) {
  if (!value || !path.isAbsolute(value) || value.includes("\0"))
    throw new Error("Use --output with an absolute, new directory");
  const result = path.normalize(value);
  if (
    result === path.parse(result).root ||
    path.resolve(result) === path.resolve(root) ||
    result === os.homedir() ||
    (process.platform === "win32" && /^[\\/]$/.test(path.parse(result).root))
  )
    throw new Error("Output must be a new dedicated directory");
  return result;
}
async function copyTree(source, target) {
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (file) => {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("Portable files must not depend on symlinks");
      const name = path.basename(file);
      return (
        ![".bin", ".pnpm", ".modules.yaml", ".pnpm-workspace-state-v1.json"].includes(name) &&
        !name.endsWith(".tsbuildinfo") &&
        !name.endsWith(".map")
      );
    },
  });
}
async function runtimeInto(destination, work) {
  const archive = runtimeArchives[process.platform];
  const url = `https://nodejs.org/download/release/v${runtimeVersion}/${archive.name}`;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok || Number(response.headers.get("content-length")) > 128 * 1024 * 1024)
    throw new Error("Runtime download rejected");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 128 * 1024 * 1024) throw new Error("Runtime archive too large");
  verifiedRuntime(bytes, archive.sha256);
  const downloaded = path.join(work, archive.name);
  await writeFile(downloaded, bytes, { flag: "wx" });
  const extracted = path.join(work, "runtime-extracted");
  await mkdir(extracted);
  const folder = `node-v${runtimeVersion}-${process.platform === "win32" ? "win" : "linux"}-x64`;
  if (process.platform === "win32") {
    await mkdir(path.join(extracted, folder));
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtimeZip = [System.IO.Compression.ZipFile]::OpenRead($env:AH_PACKAGE_ARCHIVE)
try {
  foreach ($runtimeFile in @('node.exe', 'LICENSE')) {
    $runtimeEntry = $runtimeZip.GetEntry($env:AH_PACKAGE_FOLDER + '/' + $runtimeFile)
    if ($null -eq $runtimeEntry) { throw 'Runtime entry missing' }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($runtimeEntry, [System.IO.Path]::Combine($env:AH_PACKAGE_EXTRACT, $env:AH_PACKAGE_FOLDER, $runtimeFile), $false)
  }
} finally { $runtimeZip.Dispose() }
`,
      ],
      {
        windowsHide: true,
        timeout: 60000,
        env: {
          ...process.env,
          AH_PACKAGE_ARCHIVE: downloaded,
          AH_PACKAGE_EXTRACT: extracted,
          AH_PACKAGE_FOLDER: folder,
        },
      },
    );
  } else
    await run("tar", [
      "-xzf",
      downloaded,
      "-C",
      extracted,
      `${folder}/bin/node`,
      `${folder}/LICENSE`,
    ]);
  const executable = process.platform === "win32" ? "node.exe" : "node";
  await mkdir(path.join(destination, "runtime"));
  await cp(
    path.join(extracted, folder, process.platform === "win32" ? executable : "bin/node"),
    path.join(destination, "runtime", executable),
  );
  await cp(path.join(extracted, folder, "LICENSE"), path.join(destination, "runtime", "LICENSE"));
  if (process.platform !== "win32")
    await chmod(path.join(destination, "runtime", executable), 0o755);
  return { version: runtimeVersion, url, archiveSha256: archive.sha256 };
}
async function inventory(directory) {
  const files = [];
  const packages = [];
  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error("Non-portable artifact path");
      if (info.isDirectory()) await walk(file);
      else {
        if (name.endsWith(".node"))
          throw new Error("Native dependency requires separate packaging approval");
        const bytes = await readFile(file);
        files.push({
          path: path.relative(directory, file).split(path.sep).join("/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        if (name === "package.json") {
          const manifest = JSON.parse(bytes.toString());
          if (manifest.name && manifest.version)
            packages.push({
              name: manifest.name,
              version: manifest.version,
              license: manifest.license ?? "UNDECLARED",
              path: files.at(-1).path,
            });
        }
      }
    }
  }
  await walk(directory);
  return { files, packages };
}
export async function packageCompanion(destination) {
  if (process.arch !== "x64" || !Object.hasOwn(runtimeArchives, process.platform))
    throw new Error("Only native Windows/Linux x64 builds are supported");
  const output = outputDirectory(destination);
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !path.isAbsolute(pnpm)) throw new Error("Run with pnpm package:companion");
  for (const entry of [
    "apps/hub-server/dist/companion.js",
    "packages/mcp-server/dist/main.js",
    "apps/web/dist/index.html",
  ])
    await access(path.join(root, entry));
  // Exclusive destination: no overwrites and no cleanup of user-selected paths.
  await mkdir(output);
  const work = await mkdtemp(path.join(os.tmpdir(), "ah-package-"));
  try {
    for (const [name, location] of [
      ["@agents-hub/hub-server", "apps/hub-server"],
      ["@agents-hub/mcp-server", "packages/mcp-server"],
    ]) {
      const deployed = path.join(work, name.split("/").at(-1));
      const arguments_ = [
        "--filter",
        name,
        "deploy",
        "--prod",
        "--node-linker=hoisted",
        "--ignore-scripts",
        "--frozen-lockfile",
        deployed,
      ];
      await run(
        /\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm,
        /\.[cm]?js$/.test(pnpm) ? [pnpm, ...arguments_] : arguments_,
        { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const target = path.join(output, location);
      await mkdir(target, { recursive: true });
      await copyTree(path.join(deployed, "dist"), path.join(target, "dist"));
      await copyTree(path.join(deployed, "node_modules"), path.join(target, "node_modules"));
      const manifest = JSON.parse(await readFile(path.join(deployed, "package.json"), "utf8"));
      manifest.scripts = undefined;
      manifest.devDependencies = undefined;
      await writeFile(path.join(target, "package.json"), JSON.stringify(manifest, null, 2), {
        flag: "wx",
      });
    }
    await copyTree(path.join(root, "apps/web/dist"), path.join(output, "apps/web/dist"));
    await mkdir(path.join(output, "scripts/lib"), { recursive: true });
    for (const [source, target] of [
      ["portable/launch.mjs", "scripts/launch.mjs"],
      ["mcp-config.mjs", "scripts/mcp-config.mjs"],
      ["lib/hub-url.mjs", "scripts/lib/hub-url.mjs"],
    ])
      await cp(path.join(root, "scripts", source), path.join(output, target));
    const launcher = process.platform === "win32" ? "Abrir Agents-Hub.cmd" : "abrir-agents-hub.sh";
    await cp(path.join(root, "scripts/portable", launcher), path.join(output, launcher));
    if (process.platform !== "win32") await chmod(path.join(output, launcher), 0o755);
    const runtime = await runtimeInto(output, work);
    await writeFile(
      path.join(output, "LEEME.txt"),
      "Agents-Hub: preview portable privado, sin instalador ni firma.\nAbre el launcher de esta carpeta. Mantén su consola abierta; Ctrl+C cierra el compañero.\nDatos separados de esta carpeta en LOCALAPPDATA/Agents-Hub (Windows) o XDG_DATA_HOME/agents-hub (~/.local/share/agents-hub) en Linux.\nNo se migra la DB histórica automáticamente. Reemplazar recursos no elimina datos.\nConexión MCP guiada, accesos directos e instalador nativo pendientes.\nNo publicar este preview: licencia del proyecto y release pendientes.\n",
    );
    const contents = await inventory(output);
    await writeFile(
      path.join(output, "artifact.json"),
      `${JSON.stringify(
        {
          format: 1,
          preview: true,
          platform: process.platform,
          arch: process.arch,
          runtime,
          sourceLockSha256: createHash("sha256")
            .update(await readFile(path.join(root, "pnpm-lock.yaml")))
            .digest("hex"),
          ...contents,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    return output;
  } finally {
    if (
      path.dirname(work) === path.resolve(os.tmpdir()) &&
      path.basename(work).startsWith("ah-package-")
    )
      await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output")
      throw new Error("Use --output");
    const output = await packageCompanion(process.argv[3]);
    console.log(`Preview portable creado: ${output}`);
  } catch {
    console.error(
      "No se creó un paquete completo. Usa build previo y --output con carpeta absoluta nueva; revisa red/runtime. Un destino parcial no se sobrescribe ni se borra automáticamente.",
    );
    process.exitCode = 1;
  }
}
