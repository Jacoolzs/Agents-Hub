import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";

export const AgentSessionStatusSchema = z.enum(["active", "idle", "disconnected"]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export const AgentSessionSchema = z
  .object({
    session_id: UuidSchema,
    agent_id: z.string().trim().min(1).max(100),
    project_id: UuidSchema,
    user_id: UuidSchema,
    status: AgentSessionStatusSchema,
    last_cursor: z.string().max(128).optional(),
    last_seen_at: UtcIsoDateSchema,
    created_at: UtcIsoDateSchema,
  })
  .strict();

export type AgentSession = z.infer<typeof AgentSessionSchema>;
