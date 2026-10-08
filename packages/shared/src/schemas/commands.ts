import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { CursorSchema } from "../pagination.js";
import { WorkspaceLockSchema } from "./lock.js";
import { MembershipRoleSchema } from "./project.js";
import { AgentSessionSchema } from "./session.js";
import { StatusReportSchema } from "./status.js";

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
export const RenewModuleLockInputSchema = z
  .object({
    lock_id: UuidSchema,
    ttl_seconds: z.number().int().min(1).max(3600).default(300),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();
export const CreateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    username: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const JoinSessionInputSchema = z
  .object({ agent_id: z.string().trim().min(1).max(100), instance_id: UuidSchema.optional() })
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
export const ResyncInboxInputSchema = z
  .object({
    cursor: CursorSchema,
    accept_history_gap: z.literal(true),
  })
  .strict();
export const InboxRecoverySchema = z.object({
  resume_cursor: CursorSchema,
  snapshot: z.object({
    statuses: z.array(StatusReportSchema),
    active_agents: z.array(AgentSessionSchema).optional(),
    locks: z.array(WorkspaceLockSchema).optional(),
  }),
  warning: z.string(),
});
export type InboxRecovery = z.infer<typeof InboxRecoverySchema>;
export const HubCapabilitiesSchema = z
  .object({
    api_version: z.literal("v1"),
    contract_revision: z.literal(1),
    features: z.array(
      z.enum([
        "exclusive_instances",
        "cursor_recovery",
        "explicit_ack",
        "idempotent_commands",
        "message_history",
        "message_replies",
        "explicit_lock_renewal",
      ]),
    ),
  })
  .strict();
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
