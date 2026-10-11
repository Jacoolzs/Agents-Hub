import { parseConnectionHubUrl } from "./local-connection.js";

export type ConnectionCheck = {
  name: string;
  status: "ok" | "error" | "skipped";
  code: string;
  hint: string;
};
export type ConnectionReport = { ok: boolean; checks: ConnectionCheck[] };
const features = ["exclusive_instances", "cursor_recovery", "explicit_ack", "idempotent_commands"];
const codes = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PROJECT_NOT_FOUND",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

/** Shared CLI/UI passive checks. Never returns remote data, creates sessions or follows redirects. */
export async function diagnoseHubAccess(
  connection: { baseUrl: string; token?: string | undefined; projectId?: string | undefined },
  network: typeof fetch = fetch,
): Promise<ConnectionReport> {
  const checks: ConnectionCheck[] = [];
  const add = (name: string, status: ConnectionCheck["status"], code: string, hint: string) =>
    checks.push({ name, status, code, hint });
  const report = () => ({ ok: checks.every((check) => check.status !== "error"), checks });
  let url: string;
  try {
    url = parseConnectionHubUrl(connection.baseUrl);
    add("url", "ok", "URL_VALID", "HTTPS remoto o HTTP local sin secretos ni parámetros.");
  } catch {
    add(
      "url",
      "error",
      "URL_INVALID",
      "Revisa la URL del Hub: HTTPS remoto o HTTP local sin parámetros.",
    );
    return report();
  }
  async function get(
    endpoint: string,
    authenticated = false,
  ): Promise<{
    ok: boolean;
    code: string;
    status?: number;
    data?: unknown;
  }> {
    try {
      const response = await network(`${url}${endpoint}`, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
        headers: authenticated ? { Authorization: `Bearer ${connection.token}` } : {},
      });
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, code: "INVALID_RESPONSE" };
      const chunks: Uint8Array[] = [];
      let size = 0;
      let body: { data?: unknown; error?: { code?: unknown } };
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262144) return { ok: false, code: "INVALID_RESPONSE" };
          chunks.push(chunk.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object") return { ok: false, code: "INVALID_RESPONSE" };
      } catch {
        return { ok: false, code: "INVALID_RESPONSE" };
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!response.ok) {
        const code =
          response.status === 401
            ? "UNAUTHENTICATED"
            : response.status === 403
              ? "FORBIDDEN"
              : typeof body.error?.code === "string" && codes.has(body.error.code)
                ? body.error.code
                : "API_ERROR";
        return { ok: false, code, status: response.status };
      }
      return { ok: true, code: "OK", data: body.data ?? body };
    } catch {
      return { ok: false, code: "UNREACHABLE" };
    }
  }
  const ready = await get("/health/ready");
  const prepared = ready.ok && (ready.data as { status?: unknown })?.status === "ready";
  add(
    "readiness",
    prepared ? "ok" : "error",
    prepared ? "HUB_READY" : ready.ok ? "HUB_NOT_READY" : ready.code,
    prepared
      ? "Hub preparado."
      : "Comprueba URL, certificado TLS, red y que el anfitrión tenga el Hub abierto. No se siguen redirecciones.",
  );
  const caps = await get("/v1/capabilities");
  const capabilities = caps.data as
    | { api_version?: unknown; contract_revision?: unknown; features?: unknown }
    | undefined;
  const compatible =
    caps.ok &&
    capabilities?.api_version === "v1" &&
    capabilities.contract_revision === 1 &&
    Array.isArray(capabilities.features) &&
    features.every((feature) => (capabilities.features as unknown[]).includes(feature));
  add(
    "compatibility",
    compatible ? "ok" : "error",
    compatible
      ? "HUB_COMPATIBLE"
      : !caps.ok && caps.status !== 404
        ? caps.code
        : "HUB_INCOMPATIBLE",
    compatible
      ? "Hub soporta instancias exclusivas, recuperación y ACK explícito."
      : !caps.ok && caps.status !== 404
        ? "Resuelve la conexión o acceso antes de decidir si debes actualizar."
        : "Comprueba la URL y actualiza Hub y adaptador juntos a una versión compatible.",
  );
  if (!connection.token) {
    add(
      "identity",
      "error",
      "TOKEN_MISSING",
      "Configura tu credencial personal o prepara una conexión desde el panel.",
    );
    add(
      "membership",
      "skipped",
      "NO_IDENTITY",
      "Se requiere identidad antes de comprobar membresía.",
    );
    return report();
  }
  const identity = await get("/v1/tokens", true);
  const authenticated = identity.ok && Array.isArray(identity.data);
  add(
    "identity",
    authenticated ? "ok" : "error",
    authenticated ? "IDENTITY_VALID" : identity.ok ? "INVALID_RESPONSE" : identity.code,
    authenticated
      ? "Identidad autenticada."
      : identity.code === "UNAUTHENTICATED"
        ? "Credencial inválida, vencida o revocada: revisa el dispositivo en el portal y empareja de nuevo."
        : "Comprueba acceso al Hub y los permisos de tu credencial; no la compartas en diagnósticos.",
  );
  if (!authenticated) {
    add(
      "membership",
      "skipped",
      "NO_IDENTITY",
      "Resuelve la identidad antes de comprobar el proyecto.",
    );
    return report();
  }
  const project = connection.projectId;
  if (
    !project ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(project)
  ) {
    add(
      "membership",
      "error",
      "PROJECT_ID_INVALID",
      "Selecciona un proyecto válido y prepara una conexión nueva.",
    );
    return report();
  }
  const membership = await get(`/v1/projects/${encodeURIComponent(project)}`, true);
  const accessible =
    membership.ok && (membership.data as { project_id?: unknown })?.project_id === project;
  add(
    "membership",
    accessible ? "ok" : "error",
    accessible ? "PROJECT_ACCESSIBLE" : membership.ok ? "INVALID_RESPONSE" : membership.code,
    accessible
      ? "Proyecto accesible con esta identidad y permiso projects:read."
      : membership.code === "FORBIDDEN"
        ? "Pide al anfitrión revisar tu membresía y los permisos del dispositivo."
        : "Comprueba el proyecto y sus permisos con el anfitrión.",
  );
  return report();
}
