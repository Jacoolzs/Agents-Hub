import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";
import { containsObviousSecret } from "./commands.js";
import { WebSessionSchema } from "./web-access.js";

export const DeviceRequestInputSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        (value) =>
          !Array.from(value).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) && !containsObviousSecret(value),
      ),
  })
  .strict();
export const DeviceSecretSchema = z.string().regex(/^ahd_[A-Za-z0-9_-]{43}$/);
export const DeviceRequestSchema = z
  .object({
    request_id: UuidSchema,
    device_secret: DeviceSecretSchema,
    expires_at: UtcIsoDateSchema,
  })
  .strict();
export const DevicePreviewInputSchema = z.object({ request_id: UuidSchema }).strict();
export const DeviceApproveInputSchema = z
  .object({ request_id: UuidSchema, confirm: z.literal(true) })
  .strict();
export const DeviceExchangeInputSchema = z.object({ device_secret: DeviceSecretSchema }).strict();
export const DeviceConfirmInputSchema = z.object({ confirm: z.literal(true) }).strict();
export const DeviceCredentialSchema = z
  .object({
    token: z.string().regex(/^ah_[A-Za-z0-9_-]{32}$/),
    token_id: UuidSchema,
    project_id: UuidSchema,
    expires_at: UtcIsoDateSchema,
  })
  .strict();
export const DeviceMetadataSchema = z
  .object({
    token_id: UuidSchema,
    label: z.string(),
    project_id: UuidSchema,
    created_at: UtcIsoDateSchema,
    expires_at: UtcIsoDateSchema,
    revoked_at: UtcIsoDateSchema.nullable(),
  })
  .strict();
export const DevicePreviewSchema = z
  .object({
    request_id: UuidSchema,
    label: z.string(),
    expires_at: UtcIsoDateSchema,
    profile: WebSessionSchema,
  })
  .strict();
export type DeviceMetadata = z.infer<typeof DeviceMetadataSchema>;
