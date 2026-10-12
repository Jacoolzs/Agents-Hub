import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { DeviceRequestInputSchema, DeviceRequestSchema } from "./device.js";
import { ProjectSchema } from "./project.js";

export const LocalConnectionStartInputSchema = DeviceRequestInputSchema.extend({
  hub_url: z.string().min(1).max(2048),
}).strict();
export const LocalConnectionFinishInputSchema = z
  .object({ connection_id: UuidSchema, confirm: z.literal(true) })
  .strict();
export const LocalConnectionDiagnoseInputSchema = z.object({ connection_id: UuidSchema }).strict();
export const LocalClientImportInputSchema = z
  .object({
    connection_id: UuidSchema,
    preview_id: UuidSchema,
    confirm: z.literal(true),
    client_closed: z.literal(true),
  })
  .strict();
export const LocalClientImportPreviewSchema = z
  .object({
    state: z.enum(["new", "merge", "already", "blocked"]),
    version: z.string().nullable(),
    destination: z.string(),
    count: z.number().int().min(0).max(1000),
    preview_id: UuidSchema.nullable(),
    hint: z.string().max(512),
  })
  .strict();
export const LocalClientImportResultSchema = z
  .object({ registered: z.literal(true), destination: z.string(), backup: z.string().nullable() })
  .strict();
export const LocalConnectionReportSchema = z
  .object({
    ok: z.boolean(),
    checks: z
      .array(
        z
          .object({
            name: z.string().max(40),
            status: z.enum(["ok", "error", "skipped"]),
            code: z.string().max(40),
            hint: z.string().max(512),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export const LocalConnectionAttemptSchema = DeviceRequestSchema.omit({ device_secret: true })
  .extend(LocalConnectionStartInputSchema.shape)
  .strict();

export const LocalShutdownInputSchema = z.object({ confirm: z.literal(true) }).strict();
export const LocalInstallInputSchema = z
  .object({ confirm: z.literal(true), desktop: z.boolean().default(false) })
  .strict();
export const LocalInstallationSchema = z
  .object({
    state: z.enum(["unavailable", "ready", "installed", "partial"]),
    destination: z.string().nullable(),
    data: z.string().nullable(),
  })
  .strict();
export const LocalInstallationResultSchema = z
  .object({
    installed: z.literal(true),
    destination: z.string(),
    data: z.string(),
    label: z.string(),
    shortcuts: z.array(z.string()).min(1),
  })
  .strict();

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
export const LocalWorkspaceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    person: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("new"), username: LocalUserInputSchema.shape.username }).strict(),
      z.object({ kind: z.literal("existing"), user_id: UuidSchema }).strict(),
    ]),
  })
  .strict();
export const LocalWorkspaceSchema = z
  .object({ user: LocalUserSchema, project: ProjectSchema })
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
