import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";

// Normalize and validate path: relative POSIX without .., without leading /, without null bytes
export const NormalizedWorkspacePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.includes("\0"), "Path cannot contain null bytes")
  .refine(
    (p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:/.test(p),
    "Path must be relative to workspace root",
  )
  .refine(
    (p) => !p.split(/[/\\]/).some((part) => part === ".." || part === "."),
    "Path cannot contain directory traversal ('.' or '..')",
  )
  .transform((p) => p.replace(/\\/g, "/").replace(/\/+/g, "/"));

export const WorkspaceLockSchema = z
  .object({
    lock_id: UuidSchema,
    project_id: UuidSchema,
    owner_agent_id: z.string().trim().min(1).max(100),
    paths: z.array(NormalizedWorkspacePathSchema).min(1).max(100),
    reason: z.string().trim().min(1).max(500),
    ttl_seconds: z.number().int().min(1).max(3600),
    expires_at: UtcIsoDateSchema,
    created_at: UtcIsoDateSchema,
  })
  .strict();

export type WorkspaceLock = z.infer<typeof WorkspaceLockSchema>;

export const ClaimLockInputSchema = z
  .object({
    paths: z.array(NormalizedWorkspacePathSchema).min(1).max(100),
    reason: z.string().trim().min(1).max(500),
    ttl_seconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();

export type ClaimLockInput = z.infer<typeof ClaimLockInputSchema>;

export const ReleaseLockInputSchema = z
  .object({
    paths: z.array(NormalizedWorkspacePathSchema).min(1).max(100),
  })
  .strict();

export type ReleaseLockInput = z.infer<typeof ReleaseLockInputSchema>;
