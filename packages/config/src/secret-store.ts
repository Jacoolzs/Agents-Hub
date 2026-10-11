import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { privateDirectory, verifyPrivatePath } from "./private-directory.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type RecordValue = {
  version: 1;
  provider: "dpapi" | "secret-service";
  ready: boolean;
  cipher?: string;
};

/** Capture only bounded output; never attach helper output, input or command to errors. */
async function helper(command: string, args: string[], input = "") {
  return await new Promise<{ code: number; output: string; hasError: boolean }>(
    (accept, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let bytes = 0;
      let hasError = false;
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill();
        reject(new Error("Native credential provider unavailable or timed out"));
      };
      const timer = setTimeout(fail, 15000);
      child.on("error", fail);
      child.stdin.on("error", () => {
        hasError = true;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8192) fail();
        else output += chunk;
      });
      child.stderr.on("data", () => {
        hasError = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (!failed) accept({ code: code ?? -1, output, hasError });
      });
      child.stdin.end(input);
    },
  );
}

const dpapiScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$entropy = [System.Text.Encoding]::UTF8.GetBytes($request.context)
if ($request.operation -eq 'protect') {
  $plain = [System.Text.Encoding]::UTF8.GetBytes($request.value)
  $cipher = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($cipher))
  [Array]::Clear($plain, 0, $plain.Length)
} else {
  $cipher = [Convert]::FromBase64String($request.value)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  [Array]::Clear($plain, 0, $plain.Length)
}
`;

async function dpapi(operation: "protect" | "unprotect", context: string, value: string) {
  const result = await helper(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", dpapiScript],
    // Windows PowerShell's console input codepage is not necessarily UTF-8.
    JSON.stringify({ operation, context, value }).replace(
      /[\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
  if (result.code !== 0 || result.hasError || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.output))
    throw new Error("Native credential operation failed");
  return result.output;
}

async function secretService(
  operation: "store" | "lookup" | "clear",
  namespace: string,
  id: string,
  value = "",
) {
  const args = [
    operation,
    ...(operation === "store" ? ["--label", "Agents-Hub device credential"] : []),
    "application",
    "agents-hub",
    "namespace",
    namespace,
    "device",
    id,
  ];
  const result = await helper("secret-tool", args, value);
  if (result.code === 0 && !result.hasError) return result.output;
  if (operation !== "store" && result.code === 1 && !result.hasError && result.output === "")
    return undefined;
  throw new Error("Secret Service unavailable, locked or operation failed; no plaintext fallback");
}

function validateValue(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 2048
  )
    throw new Error("Credential must be nonempty UTF-8, without NUL, at most 2048 bytes");
  if (Buffer.from(value).toString("utf8") !== value)
    throw new Error("Credential contains invalid Unicode");
}

async function exists(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** No implicit desktop service installation, token issuance, or remote revocation. */
export class NativeSecretStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory) || resolve(directory) === parse(directory).root)
      throw new Error("Credential directory must be an absolute dedicated path");
    this.directory = resolve(directory);
  }

  private async location(id: string, create: boolean) {
    if (!uuid.test(id)) throw new Error("Credential identifier must be a lowercase UUID v4");
    if (process.platform !== "win32" && process.platform !== "linux")
      throw new Error("Native credential platform unsupported");
    // Inspect every existing ancestor, not just the final directory (including Windows junctions).
    const chain: string[] = [];
    for (let current = dirname(this.directory); ; current = dirname(current)) {
      chain.unshift(current);
      if (current === dirname(current)) break;
    }
    for (const ancestor of chain) {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Credential ancestor is not a regular directory");
    }
    if (!(await exists(this.directory))) {
      if (!create) return undefined;
      await privateDirectory(this.directory);
    }
    await verifyPrivatePath(this.directory);
    const canonical = await realpath(this.directory);
    const namespace = createHash("sha256")
      .update(process.platform === "win32" ? canonical.toLowerCase() : canonical)
      .digest("hex");
    return { directory: join(canonical, id), namespace, context: `agents-hub:${namespace}:${id}` };
  }

  private async record(directory: string): Promise<RecordValue | undefined> {
    await verifyPrivatePath(directory);
    const path = join(directory, "record.json");
    if (!(await exists(path))) return undefined;
    await verifyPrivatePath(path);
    let record: RecordValue;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as RecordValue;
    } catch {
      throw new Error("Credential record is corrupt; preserve it and re-pair after revocation");
    }
    const provider = process.platform === "win32" ? "dpapi" : "secret-service";
    if (
      !record ||
      record.version !== 1 ||
      record.provider !== provider ||
      typeof record.ready !== "boolean" ||
      (provider === "dpapi" &&
        record.ready &&
        (typeof record.cipher !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.cipher))) ||
      (provider === "secret-service" && record.cipher !== undefined)
    )
      throw new Error("Credential record is invalid or belongs to another provider");
    return record;
  }

  async put(id: string, value: string): Promise<void> {
    validateValue(value);
    try {
      const location = await this.location(id, true);
      if (!location) throw new Error("Credential directory unavailable");
      await mkdir(location.directory, { mode: 0o700 }); // Exclusive reservation; never overwrite.
      await verifyPrivatePath(location.directory, true);
      const provider = process.platform === "win32" ? "dpapi" : "secret-service";
      const path = join(location.directory, "record.json");
      await writeFile(path, JSON.stringify({ version: 1, provider, ready: false }), {
        flag: "wx",
        mode: 0o600,
      });
      // wx above proves this file is new; initialize its owner as well as its ACL.
      await verifyPrivatePath(path, true);
      const cipher =
        provider === "dpapi" ? await dpapi("protect", location.context, value) : undefined;
      if (provider === "secret-service") {
        if ((await secretService("lookup", location.namespace, id)) !== undefined)
          throw new Error("Native credential entry already exists");
        await secretService("store", location.namespace, id, value);
      }
      const temporary = join(location.directory, "pending.json");
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, provider, ready: true, ...(cipher ? { cipher } : {}) }),
        { flag: "wx", mode: 0o600 },
      );
      await verifyPrivatePath(temporary, true);
      await verifyPrivatePath(location.directory);
      await verifyPrivatePath(path);
      await rename(temporary, path);
    } catch {
      throw new Error(
        "Credential could not be saved securely; existing or partial reservation preserved. Revoke issued device if needed",
      );
    }
  }

  async get(id: string): Promise<string | undefined> {
    try {
      const location = await this.location(id, false);
      if (!location || !(await exists(location.directory))) return undefined;
      const record = await this.record(location.directory);
      if (!record?.ready) throw new Error("Incomplete credential reservation");
      const value =
        record.provider === "dpapi"
          ? Buffer.from(
              await dpapi("unprotect", location.context, record.cipher ?? ""),
              "base64",
            ).toString("utf8")
          : await secretService("lookup", location.namespace, id);
      if (value !== undefined) validateValue(value);
      return value;
    } catch {
      throw new Error(
        "Credential could not be read securely; preserve record, unlock native vault or revoke and re-pair",
      );
    }
  }

  async remove(id: string): Promise<void> {
    try {
      const location = await this.location(id, false);
      if (!location || !(await exists(location.directory))) return;
      const record = await this.record(location.directory);
      const entries = await readdir(location.directory);
      if (entries.some((name) => name !== "record.json" && name !== "pending.json"))
        throw new Error("Unexpected credential files");
      for (const name of entries) await verifyPrivatePath(join(location.directory, name));
      // Even a partial store may have reached Secret Service before its local ready marker.
      if (record?.provider === "secret-service")
        await secretService("clear", location.namespace, id);
      for (const name of entries) await unlink(join(location.directory, name));
      await rmdir(location.directory);
    } catch {
      throw new Error(
        "Local credential removal failed; record preserved where possible. This does not revoke the Hub device",
      );
    }
  }
}
