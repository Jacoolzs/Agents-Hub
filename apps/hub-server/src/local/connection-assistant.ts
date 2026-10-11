import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  LocalConnectionSchema,
  NativeSecretStore,
  parseConnectionHubUrl,
  privateDirectory,
  verifyPrivatePath,
} from "@agents-hub/config";
import {
  AppError,
  DeviceCredentialSchema,
  DeviceRequestSchema,
  LocalConnectionAttemptSchema,
  LocalConnectionFinishInputSchema,
  LocalConnectionStartInputSchema,
} from "@agents-hub/shared";

type Vault = Pick<NativeSecretStore, "put" | "get" | "remove">;
const unavailable = () =>
  new AppError(
    "STATE_CONFLICT",
    "No se completó la conexión. Revisa o revoca el dispositivo en el portal y crea otra solicitud; no se repetirá el canje ni se reemplazarán archivos.",
  );

/** Instantiate only after acquiring companion ownership; caller drains operations before release. */
export class ConnectionAssistant {
  private busy = false;
  private pending = new Map<string, string>();
  private vault: Vault;
  constructor(
    private directory: string,
    private mcpScript: string,
    private node: string = process.execPath,
    private network: typeof fetch = fetch,
    vault?: Vault,
  ) {
    if (!isAbsolute(directory) || !isAbsolute(mcpScript) || !isAbsolute(node))
      throw new Error("Connection resources require absolute paths");
    this.directory = resolve(directory);
    this.vault = vault ?? new NativeSecretStore(join(this.directory, "credentials"));
  }
  private async exclusive<T>(work: () => Promise<T>) {
    if (this.busy) throw unavailable();
    this.busy = true;
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    } finally {
      this.busy = false;
    }
  }
  private async inspectAncestors() {
    for (let target = dirname(this.directory); ; target = dirname(target)) {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable();
      if (target === dirname(target)) return;
    }
  }
  private attempt(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      throw unavailable();
    return join(this.directory, "attempts", id);
  }
  private async write(target: string, value: unknown) {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 4096) throw unavailable();
    const file = await open(target, "wx", 0o600);
    try {
      await verifyPrivatePath(target, true);
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async read(target: string) {
    await verifyPrivatePath(target);
    return JSON.parse(await readFile(target, "utf8"));
  }
  private async exists(target: string) {
    try {
      await lstat(target);
      await verifyPrivatePath(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async post(url: string, endpoint: string, body: unknown) {
    const response = await this.network(`${url}${endpoint}`, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Never echo untrusted remote diagnostics or allow an unbounded body.
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) throw unavailable();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!response.ok) throw unavailable();
    return JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
  }
  private async probeVault() {
    const probe = randomUUID();
    const value = randomUUID();
    await this.vault.put(probe, value);
    try {
      if ((await this.vault.get(probe)) !== value) throw unavailable();
    } finally {
      await this.vault.remove(probe);
    }
  }
  async start(input: unknown) {
    const parsed = LocalConnectionStartInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        "Escribe la URL del Hub y un nombre para este dispositivo.",
      );
    let url: string;
    try {
      url = parseConnectionHubUrl(parsed.data.hub_url);
    } catch {
      throw new AppError(
        "INVALID_INPUT",
        "Usa HTTPS remoto o HTTP local sin secretos ni parámetros.",
      );
    }
    return this.exclusive(async () => {
      await this.inspectAncestors();
      await privateDirectory(this.directory);
      await privateDirectory(join(this.directory, "attempts"));
      // Verify roundtrip/removal before any remote issuance. Never reuse an existing UUID.
      await this.probeVault();
      const id = randomUUID();
      const directory = this.attempt(id);
      await privateDirectory(directory);
      const request = DeviceRequestSchema.parse(
        await this.post(url, "/v1/devices/requests", { label: parsed.data.label }),
      );
      await this.write(join(directory, "request.json"), {
        request_id: request.request_id,
        expires_at: request.expires_at,
        hub_url: url,
        label: parsed.data.label,
      });
      this.pending.set(id, request.device_secret);
      return {
        connection_id: id,
        request_id: request.request_id,
        expires_at: request.expires_at,
        portal_url: `${url}/#device-request=${request.request_id}`,
      };
    });
  }
  async finish(input: unknown) {
    const parsed = LocalConnectionFinishInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("INVALID_INPUT", "Confirma el guardado de la conexión.");
    return this.exclusive(async () => {
      const id = parsed.data.connection_id;
      await this.inspectAncestors();
      await verifyPrivatePath(this.directory);
      await verifyPrivatePath(join(this.directory, "attempts"));
      const directory = this.attempt(id);
      await verifyPrivatePath(directory);
      const record = LocalConnectionAttemptSchema.parse(
        await this.read(join(directory, "request.json")),
      );
      const url = parseConnectionHubUrl(record.hub_url);
      const secret = this.pending.get(id);
      if (!secret || Date.parse(record.expires_at) <= Date.now()) throw unavailable();
      if (await this.exists(join(this.directory, `${id}.json`))) throw unavailable();
      await this.probeVault();
      // A durable fence precedes sending: errors, crash and lost responses can NEVER retry.
      await this.write(join(directory, "exchange.json"), { version: 1 });
      this.pending.delete(id);
      const credential = DeviceCredentialSchema.parse(
        await this.post(url, "/v1/devices/exchange", { device_secret: secret }),
      );
      const profile = LocalConnectionSchema.parse({
        version: 1,
        credential_id: id,
        hub_url: url,
        project_id: credential.project_id,
        token_id: credential.token_id,
        expires_at: credential.expires_at,
      });
      if (Date.parse(profile.expires_at) <= Date.now()) throw unavailable();
      const staged = join(directory, "connection.json");
      await this.write(staged, profile); // recovery metadata only, never bearer
      await this.vault.put(id, credential.token);
      if ((await this.vault.get(id)) !== credential.token) throw unavailable();
      await verifyPrivatePath(staged);
      await verifyPrivatePath(this.directory);
      const file = join(this.directory, `${id}.json`);
      await link(staged, file); // Atomic complete publication, fails if destination exists.
      return { connection_id: id, file, profile, config: this.config(file, record.label, id) };
    });
  }
  private config(file: string, label: string, id: string) {
    const name =
      label
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "agente";
    return {
      mcpServers: {
        "agents-hub": {
          command: this.node,
          args: [this.mcpScript],
          env: { AGENTS_HUB_CONNECTION_FILE: file, AGENTS_HUB_AGENT_NAME: `${name}-${id}` },
        },
      },
    };
  }
  async list() {
    return this.exclusive(async () => {
      await this.inspectAncestors();
      if (!(await this.exists(this.directory))) return [];
      const attempts = join(this.directory, "attempts");
      if (!(await this.exists(attempts))) return [];
      const ids = await readdir(attempts);
      if (ids.length > 100) throw unavailable();
      const result = [];
      for (const id of ids) {
        const directory = this.attempt(id);
        await verifyPrivatePath(directory);
        const requestFile = join(directory, "request.json");
        if (!(await this.exists(requestFile))) continue; // no issued token before this marker
        const request = LocalConnectionAttemptSchema.parse(await this.read(requestFile));
        const file = join(this.directory, `${id}.json`);
        const profile = (await this.exists(file))
          ? LocalConnectionSchema.parse(await this.read(file))
          : null;
        if (profile && (profile.credential_id !== id || profile.hub_url !== request.hub_url))
          throw unavailable();
        const issued = join(directory, "connection.json");
        const known = (await this.exists(issued))
          ? LocalConnectionSchema.parse(await this.read(issued))
          : null;
        result.push({
          connection_id: id,
          ...request,
          state: profile
            ? "saved"
            : this.pending.has(id) &&
                Date.parse(request.expires_at) > Date.now() &&
                !(await this.exists(join(directory, "exchange.json")))
              ? "waiting"
              : "recovery",
          token_id: profile?.token_id ?? known?.token_id ?? null,
          file: profile ? file : null,
          config: profile ? this.config(file, request.label, id) : null,
        });
      }
      return result;
    });
  }
}
