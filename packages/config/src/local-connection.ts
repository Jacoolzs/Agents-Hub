import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { verifyPrivatePath } from "./private-directory.js";
import { NativeSecretStore } from "./secret-store.js";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const obviousSecret = /(?:ah_|ahb_|ahd_|ahp_|ahi_|wst_|sk-)[A-Za-z0-9_-]{8,}|Bearer\s+\S+/i;

export function parseConnectionHubUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    obviousSecret.test(value) ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use remote HTTPS or loopback HTTP without credentials, query or fragment");
  return url.href.replace(/\/+$/, "");
}

export const LocalConnectionSchema = z
  .object({
    version: z.literal(1),
    credential_id: uuid,
    hub_url: z.string().max(2048).transform(parseConnectionHubUrl),
    project_id: uuid,
    token_id: uuid,
    expires_at: z.string().refine((value) => {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString() === value;
    }),
  })
  .strict();
export type LocalConnection = z.infer<typeof LocalConnectionSchema>;

export class LocalConnectionError extends Error {
  constructor(
    public readonly code:
      | "CONNECTION_CONFLICT"
      | "CONNECTION_INVALID"
      | "CONNECTION_EXPIRED"
      | "CREDENTIAL_UNAVAILABLE",
  ) {
    super(
      "Local connection unavailable. Check private profile/vault, unlock it or revoke device and re-pair; no fallback",
    );
    this.name = "LocalConnectionError";
  }
}

/** Read only: never repairs permissions, creates a profile or opens the Hub. */
export async function loadLocalConnection(file: string) {
  let profile: LocalConnection;
  let directory: string;
  try {
    if (!isAbsolute(file) || obviousSecret.test(file)) throw new Error("Invalid path");
    const path = resolve(file);
    directory = dirname(path);
    for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invalid ancestor");
      if (ancestor === dirname(ancestor)) break;
    }
    await verifyPrivatePath(directory);
    await verifyPrivatePath(path);
    profile = LocalConnectionSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (basename(path) !== `${profile.credential_id}.json`) throw new Error("Reference mismatch");
  } catch {
    throw new LocalConnectionError("CONNECTION_INVALID");
  }
  if (Date.parse(profile.expires_at) <= Date.now())
    throw new LocalConnectionError("CONNECTION_EXPIRED");
  let token: string | undefined;
  try {
    token = await new NativeSecretStore(join(directory, "credentials")).get(profile.credential_id);
    if (!token || !/^ah_[A-Za-z0-9_-]{32}$/.test(token)) throw new Error("Not an MCP bearer");
  } catch {
    throw new LocalConnectionError("CREDENTIAL_UNAVAILABLE");
  }
  // Native provider can block for unlock: recheck expiry after awaiting it.
  if (Date.parse(profile.expires_at) <= Date.now())
    throw new LocalConnectionError("CONNECTION_EXPIRED");
  return { profile, baseUrl: profile.hub_url, projectId: profile.project_id, token };
}

export async function resolveAgentConnection(
  env: Record<string, string | undefined> = process.env,
) {
  if (env.AGENTS_HUB_CONNECTION_FILE !== undefined) {
    if (
      ["AGENTS_HUB_TOKEN", "AGENTS_HUB_URL", "AGENTS_HUB_PROJECT_ID"].some(
        (key) => env[key] !== undefined,
      )
    )
      throw new LocalConnectionError("CONNECTION_CONFLICT");
    return await loadLocalConnection(env.AGENTS_HUB_CONNECTION_FILE);
  }
  const baseUrl = parseConnectionHubUrl(env.AGENTS_HUB_URL || "http://127.0.0.1:8787");
  const token = env.AGENTS_HUB_TOKEN || "";
  if (!token) throw new Error("AGENTS_HUB_TOKEN or local connection reference required");
  return { baseUrl, token, projectId: env.AGENTS_HUB_PROJECT_ID };
}
