import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHubUrl } from "./lib/hub-url.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function runDoctor({
  env = process.env,
  root = projectRoot,
  runtimeVersion = process.versions.node,
  fetchImpl = globalThis.fetch,
} = {}) {
  const checks = [];
  const add = (name, status, code, hint) => checks.push({ name, status, code, hint });
  const report = () => ({ ok: checks.every((check) => check.status !== "error"), checks });
  const major = Number(runtimeVersion.split(".")[0]);
  add(
    "runtime",
    major === 24 ? "ok" : "error",
    major === 24 ? "NODE_24" : "UNSUPPORTED_RUNTIME",
    major === 24 ? "Node 24 disponible." : "Usa Node 24 LTS para ejecutar el adaptador.",
  );
  const build = [
    "packages/mcp-server/dist/main.js",
    "packages/shared/dist/index.js",
    "packages/config/dist/index.js",
  ].every((file) => existsSync(path.join(root, file)));
  add(
    "build",
    build ? "ok" : "error",
    build ? "BUILD_READY" : "BUILD_MISSING",
    build
      ? "Artefactos locales disponibles; no garantiza que estén actualizados."
      : "Ejecuta pnpm install --frozen-lockfile y pnpm build.",
  );

  let baseUrl;
  let token = env.AGENTS_HUB_TOKEN;
  let projectId = env.AGENTS_HUB_PROJECT_ID;
  if (env.AGENTS_HUB_CONNECTION_FILE !== undefined) {
    try {
      const { resolveAgentConnection } = await import(
        pathToFileURL(path.join(root, "packages/config/dist/index.js")).href
      );
      const connection = await resolveAgentConnection(env);
      baseUrl = connection.baseUrl;
      token = connection.token;
      projectId = connection.projectId;
      add(
        "connection",
        "ok",
        "LOCAL_CONNECTION_READY",
        "Referencia privada y almacén nativo disponibles; validez remota pendiente.",
      );
    } catch (error) {
      const codes = new Set([
        "CONNECTION_CONFLICT",
        "CONNECTION_INVALID",
        "CONNECTION_EXPIRED",
        "CREDENTIAL_UNAVAILABLE",
      ]);
      add(
        "connection",
        "error",
        codes.has(error?.code) ? error.code : "CONNECTION_INVALID",
        "Revisa referencia privada, expiración y almacén nativo. Desbloquea el llavero o revoca y empareja de nuevo. No mezcles referencia con TOKEN/URL/PROJECT_ID legacy.",
      );
      return report();
    }
  }
  try {
    baseUrl = parseHubUrl(baseUrl ?? env.AGENTS_HUB_URL ?? "http://127.0.0.1:8787");
    add("url", "ok", "URL_VALID", "HTTPS remoto o HTTP de loopback, sin credenciales en la URL.");
  } catch {
    add(
      "url",
      "error",
      "URL_INVALID",
      "Configura AGENTS_HUB_URL con HTTPS remoto o HTTP de localhost, sin usuario, contraseña, query ni fragmento.",
    );
    return report();
  }

  const { diagnoseHubAccess } = await import(
    pathToFileURL(path.join(root, "packages/config/dist/index.js")).href
  );
  const remote = await diagnoseHubAccess({ baseUrl, token, projectId }, fetchImpl);
  // URL was checked above to preserve the CLI's established output order.
  checks.push(...remote.checks.filter((check) => check.name !== "url"));
  return report();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) {
    console.error("Uso: pnpm doctor [--json]");
    process.exitCode = 1;
  } else {
    const result = await runDoctor();
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else
      for (const check of result.checks)
        console.log(`${check.status.toUpperCase()} ${check.name} (${check.code}): ${check.hint}`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
