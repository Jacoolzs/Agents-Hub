import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";
import { MembershipRoleSchema } from "./project.js";

export const BROWSER_AUDIENCE = "agents-hub-browser";
export const WebEntryInputSchema = z.object({ project_id: UuidSchema }).strict();
export const WebInvitationRoleSchema = z.enum(["reader", "collaborator", "maintainer"]);
export const WebInvitationInputSchema = z
  .object({
    project_id: UuidSchema,
    person: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("new"),
          username: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9._-]{1,80}$/),
        })
        .strict(),
      z.object({ kind: z.literal("existing"), user_id: UuidSchema }).strict(),
    ]),
    role: WebInvitationRoleSchema,
    ttl_seconds: z.number().int().min(60).max(604800).default(3600),
  })
  .strict();
export const WebInvitationMetadataSchema = z
  .object({
    entry_id: UuidSchema,
    user_id: UuidSchema,
    username: z.string(),
    project_id: UuidSchema,
    project_name: z.string(),
    pending_role: WebInvitationRoleSchema,
    expires_at: UtcIsoDateSchema,
    created_at: UtcIsoDateSchema,
    consumed_at: UtcIsoDateSchema.nullable(),
    revoked_at: UtcIsoDateSchema.nullable(),
  })
  .strict();
export type WebInvitationMetadata = z.infer<typeof WebInvitationMetadataSchema>;
export const WebEntrySecretSchema = z.string().regex(/^ahb_[A-Za-z0-9_-]{43}$/);
export const WebEntryExchangeSchema = z.object({ secret: WebEntrySecretSchema }).strict();
export const WebEntrySchema = z
  .object({
    entry_id: UuidSchema,
    secret: WebEntrySecretSchema,
    expires_at: UtcIsoDateSchema,
  })
  .strict();
export const WebSessionSchema = z
  .object({
    user: z.object({ user_id: UuidSchema, username: z.string().min(1) }).strict(),
    project: z
      .object({ project_id: UuidSchema, name: z.string().min(1), role: MembershipRoleSchema })
      .strict(),
    expires_at: UtcIsoDateSchema,
  })
  .strict();
export type WebSession = z.infer<typeof WebSessionSchema>;
