import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { ProjectSchema } from "./project.js";

export const LocalUserSchema = z.object({
  user_id: UuidSchema,
  username: z.string(),
  created_at: z.string(),
});
export const LocalAccessSchema = z.object({
  token_id: UuidSchema,
  audience: z.string().default("agents-hub"),
  subject: UuidSchema,
  project_id: UuidSchema.nullable(),
  expires_at: z.string(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});
export const LocalAccessInputSchema = z
  .object({
    ttl_seconds: z.number().int().min(60).max(2592000).default(28800),
    project_id: UuidSchema.optional(),
  })
  .strict();
export const LocalUserInputSchema = z
  .object({
    username: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,80}$/),
    ttl_seconds: z.number().int().min(60).max(2592000).default(28800),
  })
  .strict();
export const LocalProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    user_id: UuidSchema,
  })
  .strict();
export const LocalBootstrapSchema = z
  .object({
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const LocalIssuedAccessSchema = z.object({
  token: z.string().startsWith("ah_"),
  token_id: UuidSchema,
  user_id: UuidSchema,
  expires_at: z.string(),
});
export const LocalSnapshotSchema = z.object({
  users: z.array(LocalUserSchema),
  accesses: z.array(LocalAccessSchema),
  projects: z.array(ProjectSchema),
});
export const LocalRuntimeStateSchema = z.object({
  hub: z.enum(["stopped", "running"]),
  sharing: z.enum(["stopped", "running"]),
  portal_url: z.string().url().nullable(),
});
export const LocalControlSnapshotSchema = LocalSnapshotSchema.extend({
  runtime: LocalRuntimeStateSchema,
});
export type LocalUser = z.infer<typeof LocalUserSchema>;
export type LocalAccess = z.infer<typeof LocalAccessSchema>;
export type LocalIssuedAccess = z.infer<typeof LocalIssuedAccessSchema>;
