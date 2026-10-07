import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";

export const StatusProgressSchema = z.enum(["started", "in_progress", "blocked", "completed"]);
export type StatusProgress = z.infer<typeof StatusProgressSchema>;

export const StatusReportSchema = z
  .object({
    status_id: UuidSchema,
    project_id: UuidSchema,
    agent_id: z.string().trim().min(1).max(100),
    objective: z.string().trim().min(1).max(500),
    progress: StatusProgressSchema,
    decision: z.string().trim().max(1000).optional(),
    blocked_by: z.string().trim().max(500).optional(),
    next_step: z.string().trim().max(500).optional(),
    reported_at: UtcIsoDateSchema,
  })
  .strict();

export type StatusReport = z.infer<typeof StatusReportSchema>;

export const ReportStatusInputSchema = z
  .object({
    objective: z.string().trim().min(1).max(500),
    progress: StatusProgressSchema.default("in_progress"),
    decision: z.string().trim().max(1000).optional(),
    blocked_by: z.string().trim().max(500).optional(),
    next_step: z.string().trim().max(500).optional(),
  })
  .strict();

export type ReportStatusInput = z.infer<typeof ReportStatusInputSchema>;
