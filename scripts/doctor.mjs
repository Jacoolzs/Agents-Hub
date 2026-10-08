import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHubUrl } from "./lib/hub-url.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const knownCodes = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PROJECT_NOT_FOUND",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
const requiredFeatures = [
  "exclusive_instances",
  "cursor_recovery",
  "explicit_ack",
  "idempotent_commands",
];

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
  try {
    baseUrl = parseHubUrl(env.AGENTS_HUB_URL || "http://127.0.0.1:8787");
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

  async function request(endpoint, authenticated = false) {
    try {
      const response = await fetchImpl(`${baseUrl}${endpoint}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: authenticated ? { Authorization: `Bearer ${env.AGENTS_HUB_TOKEN}` } : {},
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const code = knownCodes.has(body?.error?.code) ? body.error.code : "API_ERROR";
        return { ok: false, code, status: response.status };
      }
      return { ok: true, data: body?.data ?? body };
    } catch {
      return { ok: false, code: "UNREACHABLE" };
    }
  }

  const readiness = await request("/health/ready");
  add(
    "readiness",
    readiness.ok && readiness.data?.status === "ready" ? "ok" : "error",
    readiness.ok
      ? readiness.data?.status === "ready"
        ? "HUB_READY"
        : "HUB_NOT_READY"
      : readiness.code,
    readiness.ok && readiness.data?.status === "ready"
      ? "Hub preparado."
      : "Comprueba URL, certificado TLS, red, proceso Hub y su readiness; no se siguen redirecciones.",
  );
  const capabilities = await request("/v1/capabilities");
  const compatible =
    capabilities.ok &&
    capabilities.data?.api_version === "v1" &&
    capabilities.data?.contract_revision === 1 &&
    Array.isArray(capabilities.data?.features) &&
    requiredFeatures.every((feature) => capabilities.data.features.includes(feature));
  add(
    "compatibility",
    compatible ? "ok" : "error",
    compatible
      ? "HUB_COMPATIBLE"
      : !capabilities.ok && capabilities.status !== 404
        ? capabilities.code
        : "HUB_INCOMPATIBLE",
    compatible
      ? "Hub soporta instancias exclusivas, recuperación y ACK explícito."
      : !capabilities.ok && capabilities.status !== 404
        ? "No se pudo comprobar compatibilidad. Resuelve la conexión o acceso antes de decidir si debes actualizar."
        : "Comprueba la URL y actualiza Hub/adaptador juntos a una versión que anuncie /v1/capabilities y los contratos actuales.",
  );

  if (!env.AGENTS_HUB_TOKEN) {
    add("identity", "error", "TOKEN_MISSING", "Configura AGENTS_HUB_TOKEN con tu token personal.");
    add(
      "membership",
      "skipped",
      "NO_IDENTITY",
      "Se requiere identidad antes de comprobar membresía.",
    );
    return report();
  }
  // This existing route proves authentication without creating a session. Do not print its data.
  const identity = await request("/v1/tokens", true);
  add(
    "identity",
    identity.ok && Array.isArray(identity.data) ? "ok" : "error",
    identity.ok
      ? Array.isArray(identity.data)
        ? "IDENTITY_VALID"
        : "INVALID_RESPONSE"
      : identity.code,
    identity.ok && Array.isArray(identity.data)
      ? "Identidad autenticada."
      : identity.code === "UNAUTHENTICATED"
        ? "Token inválido, vencido o revocado: solicita una credencial nueva al anfitrión."
        : "Comprueba acceso al Hub y tu token personal; no lo compartas en diagnósticos.",
  );
  if (!identity.ok || !Array.isArray(identity.data)) {
    add("membership", "skipped", "NO_IDENTITY", "Resolver identidad antes de comprobar membresía.");
    return report();
  }
  const projectId = env.AGENTS_HUB_PROJECT_ID;
  if (
    !projectId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)
  ) {
    add(
      "membership",
      "error",
      "PROJECT_ID_INVALID",
      "Configura AGENTS_HUB_PROJECT_ID con el UUID del proyecto.",
    );
    return report();
  }
  const membership = await request(`/v1/projects/${encodeURIComponent(projectId)}`, true);
  const accessible = membership.ok && membership.data?.project_id === projectId;
  add(
    "membership",
    accessible ? "ok" : "error",
    accessible ? "PROJECT_ACCESSIBLE" : (membership.code ?? "INVALID_RESPONSE"),
    accessible
      ? "Proyecto accesible con esta identidad y scope projects:read."
      : membership.code === "FORBIDDEN"
        ? "Acepta la invitación, solicita membresía o revisa el binding/scopes del token."
        : "Comprueba el ID de proyecto y permisos con el anfitrión.",
  );
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
