import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";
import { MembershipRoleSchema } from "./project.js";

export const BROWSER_AUDIENCE = "agents-hub-browser";
export const WebEntryInputSchema = z.object({ project_id: UuidSchema }).strict();
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
