import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { privateDirectory, verifyPrivatePath } from "@agents-hub/config";
import { AppError } from "@agents-hub/shared";

const run = promisify(execFile);
const limit = 262144;
const failure = () =>
  new AppError(
    "STATE_CONFLICT",
    "No se completó la importación. Cierra Antigravity, revisa permisos/configuración y solicita otra revisión. Se conservan archivos y copias; no repitas un canje de credenciales.",
  );
type Entry = { command: string; args: string[]; env: Record<string, string> };
type Document = Record<string, unknown> & { mcpServers: Record<string, unknown> };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** JSON.parse accepts duplicate keys; refuse them instead of silently losing foreign settings. */
function document(bytes: string): Document {
  const parsed = JSON.parse(bytes);
  const levels: (Set<string> | null)[] = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g;
  for (const token of bytes.matchAll(tokens)) {
    const value = token[0];
    if (value === "{" || value === "[") {
      levels.push(value === "{" ? new Set() : null);
      if (levels.length > 64) throw failure();
    } else if (value === "}" || value === "]") levels.pop();
    else {
      let next = (token.index ?? 0) + value.length;
      while (/\s/.test(bytes[next] ?? "") && next < bytes.length) next++;
      const keys = levels.at(-1);
      if (bytes[next] === ":" && keys) {
        const key = JSON.parse(value) as string;
        if (keys.has(key)) throw failure();
        keys.add(key);
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure();
  const servers = Object.hasOwn(parsed, "mcpServers") ? parsed.mcpServers : {};
  if (
    !servers ||
    typeof servers !== "object" ||
    Array.isArray(servers) ||
    Object.keys(servers).length > 1000
  )
    throw failure();
  return { ...parsed, mcpServers: servers };
}

async function installedVersion() {
  try {
    const result = await run(process.platform === "win32" ? "agy.exe" : "agy", ["--version"], {
      timeout: 5000,
      maxBuffer: 8192,
      windowsHide: true,
    });
    return result.stdout.trim().length <= 32 && /^\d+\.\d+\.\d+$/.test(result.stdout.trim())
      ? result.stdout.trim()
      : null;
  } catch {
    return null;
  }
}

/** No I/O at construction. Tests inject TEMP home/probe; browser never supplies paths or commands. */
export class AntigravityImporter {
  readonly destination: string;
  private reviews = new Map<
    string,
    { connection: string; snapshot: string; entry: string; expires: number }
  >();
  constructor(
    private home = homedir(),
    private version = installedVersion,
    private beforePublish?: () => Promise<void>, // fault injection only; no environment override
  ) {
    if (!isAbsolute(home)) throw failure();
    this.home = resolve(home);
    this.destination = join(this.home, ".gemini", "config", "mcp_config.json");
  }
  private async inspect(create = false) {
    for (let ancestor = this.home; ; ancestor = dirname(ancestor)) {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw failure();
      if (ancestor === dirname(ancestor)) break;
    }
    for (const directory of [join(this.home, ".gemini"), dirname(this.destination)]) {
      if (create) await privateDirectory(directory);
      else {
        try {
          await verifyPrivatePath(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw failure();
        }
      }
    }
    return true;
  }
  private async read(target = this.destination) {
    try {
      const info = await lstat(target);
      if (info.nlink !== 1) throw failure();
      await verifyPrivatePath(target, false, limit);
      const raw = await readFile(target);
      if (raw.byteLength > limit) throw failure();
      const bytes = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      return { snapshot: hash(raw), document: document(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { snapshot: "absent", document: { mcpServers: {} } as Document };
      throw failure();
    }
  }
  private async ensureNoRecovery() {
    const operations = (await readdir(dirname(this.destination))).filter((name) =>
      name.startsWith(".agents-hub-import-"),
    );
    if (operations.length > 100) throw failure();
    for (const name of operations) {
      const operation = join(dirname(this.destination), name);
      await verifyPrivatePath(operation);
      const marker = join(operation, "registered.json");
      await verifyPrivatePath(marker);
      const completed = JSON.parse(await readFile(marker, "utf8"));
      if (!completed || completed.version !== 1 || Object.keys(completed).length !== 1)
        throw failure();
    }
  }
  async preview(connection: string, entry: Entry) {
    try {
      const version = await this.version();
      if (version !== "1.3.3")
        return {
          state: "blocked" as const,
          version,
          destination: this.destination,
          count: 0,
          preview_id: null,
          hint: "Este adaptador admite Antigravity CLI 1.3.3. No se verificó esa versión; utiliza la configuración genérica.",
        };
      const present = await this.inspect();
      if (present) await this.ensureNoRecovery();
      const observed = present
        ? await this.read()
        : { snapshot: "absent", document: { mcpServers: {} } as Document };
      const existing = observed.document.mcpServers["agents-hub"];
      if (
        !Object.hasOwn(observed.document.mcpServers, "agents-hub") &&
        Object.keys(observed.document.mcpServers).length >= 1000
      )
        return {
          state: "blocked" as const,
          version,
          destination: this.destination,
          count: 1000,
          preview_id: null,
          hint: "El perfil alcanzó el límite de 1000 entradas. No se modificará; utiliza la exportación genérica y revisa el cliente.",
        };
      if (
        Object.hasOwn(observed.document.mcpServers, "agents-hub") &&
        canonical(existing) !== canonical(entry)
      )
        return {
          state: "blocked" as const,
          version,
          destination: this.destination,
          count: Object.keys(observed.document.mcpServers).length,
          preview_id: null,
          hint: "Ya existe un MCP llamado agents-hub con otra configuración. No lo reemplazaremos; revísalo desde Antigravity o utiliza la exportación genérica.",
        };
      for (const [id, review] of this.reviews)
        if (review.expires <= Date.now()) this.reviews.delete(id);
      if (this.reviews.size >= 16) throw failure();
      const id = randomUUID();
      this.reviews.set(id, {
        connection,
        snapshot: observed.snapshot,
        entry: canonical(entry),
        expires: Date.now() + 120000,
      });
      return {
        state: existing
          ? ("already" as const)
          : observed.snapshot === "absent"
            ? ("new" as const)
            : ("merge" as const),
        version,
        destination: this.destination,
        count: Object.keys(observed.document.mcpServers).length,
        preview_id: id,
        hint: "Cierra Antigravity antes de confirmar. Conservaremos sus entradas y una copia privada del archivo original, si existe.",
      };
    } catch {
      throw failure();
    }
  }
  async apply(connection: string, preview: string, entry: Entry) {
    const review = this.reviews.get(preview);
    this.reviews.delete(preview); // one use, including stale inputs and failures
    if (
      !review ||
      review.connection !== connection ||
      review.expires <= Date.now() ||
      review.entry !== canonical(entry)
    )
      throw failure();
    let original: string | null = null;
    let moved = false;
    let published = false;
    try {
      if ((await this.version()) !== "1.3.3") throw failure();
      const present = await this.inspect();
      if (present) await this.ensureNoRecovery();
      const observed = present
        ? await this.read()
        : { snapshot: "absent", document: { mcpServers: {} } as Document };
      if (observed.snapshot !== review.snapshot) throw failure();
      if (Object.hasOwn(observed.document.mcpServers, "agents-hub")) {
        if (canonical(observed.document.mcpServers["agents-hub"]) !== canonical(entry))
          throw failure();
        return { registered: true as const, destination: this.destination, backup: null };
      }
      await this.inspect(true);
      if (Date.now() >= review.expires) throw failure();
      const operation = join(dirname(this.destination), `.agents-hub-import-${randomUUID()}`);
      await privateDirectory(operation);
      const staged = join(operation, "replacement.json");
      const bytes = JSON.stringify(
        {
          ...observed.document,
          mcpServers: { ...observed.document.mcpServers, "agents-hub": entry },
        },
        null,
        2,
      );
      if (Buffer.byteLength(bytes) > limit) throw failure();
      const file = await open(staged, "wx", 0o600);
      try {
        await verifyPrivatePath(staged, true, limit);
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.inspect();
      if ((await this.read()).snapshot !== review.snapshot) throw failure();
      if (Date.now() >= review.expires) throw failure();
      if (review.snapshot !== "absent") {
        original = join(operation, "original.json");
        await rename(this.destination, original);
        moved = true;
        if ((await this.read(original)).snapshot !== review.snapshot) throw failure();
      }
      await this.beforePublish?.();
      if (Date.now() >= review.expires) throw failure();
      await link(staged, this.destination); // never overwrite a file created by another writer
      published = true;
      await unlink(staged); // only our staged new file, not the user's backup
      if ((await this.read()).snapshot !== hash(bytes)) throw failure();
      const marker = await open(join(operation, "registered.json"), "wx", 0o600);
      try {
        await verifyPrivatePath(join(operation, "registered.json"), true);
        await marker.writeFile('{"version":1}');
        await marker.sync();
      } finally {
        await marker.close();
      }
      return { registered: true as const, destination: this.destination, backup: original };
    } catch {
      if (moved && original && !published) {
        // Exclusive restoration; a concurrent destination always wins and remains untouched.
        await link(original, this.destination).catch(() => {});
      }
      throw failure();
    }
  }
}
