import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { CursorSchema } from "../pagination.js";
import { MembershipRoleSchema } from "./project.js";

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
export const CreateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    username: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const JoinSessionInputSchema = z
  .object({ agent_id: z.string().trim().min(1).max(100) })
  .strict();
export const JoinProjectInputSchema = z
  .object({
    project_id: UuidSchema,
    agent_name: z.string().trim().min(1).max(100),
    capabilities: z.array(z.string().min(1).max(100)).max(20).optional(),
  })
  .strict();
export const CheckInboxInputSchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const WaitForMessagesInputSchema = z
  .object({
    cursor: CursorSchema.optional(),
    timeout_seconds: z.number().int().min(1).max(60).default(10),
  })
  .strict();
export const AckInboxInputSchema = z.object({ cursor: CursorSchema }).strict();
export const SessionActionInputSchema = z
  .object({
    project_id: UuidSchema,
    agent_id: z.string().trim().min(1).max(100),
  })
  .strict();
export const CreateInvitationInputSchema = z
  .object({
    role: z.enum(["maintainer", "collaborator", "reader"]).default("collaborator"),
    ttl_seconds: z.number().int().min(60).max(604800).default(86400),
  })
  .strict();
export const AcceptInvitationInputSchema = z
  .object({ token: z.string().min(16).max(128) })
  .strict();
export const ChangeMemberInputSchema = z.object({ role: MembershipRoleSchema }).strict();
export const EmptyInputSchema = z.object({}).strict();

export function containsObviousSecret(value: string): boolean {
  return /\b(?:ah_|wst_|ahi_|sk-)[A-Za-z0-9_-]{8,}|Bearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(
    value,
  );
}

export const InboxResponseSchema = z.object({
  events: z.array(z.lazy(() => EventEnvelopeSchema)),
  next_cursor: CursorSchema,
  has_more: z.boolean(),
});
import { EventEnvelopeSchema } from "../events.js";
