import { z } from "zod";
import { UuidSchema } from "./ids.js";
import { SequenceNumberSchema } from "./pagination.js";
import { UtcIsoDateSchema } from "./time.js";

// Max event payload size: 64 KiB (65536 bytes)
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export const EventTypeSchema = z.enum([
  "project.created",
  "membership.updated",
  "agent.joined",
  "agent.heartbeat",
  "agent.idle",
  "agent.left",
  "message.created",
  "status.updated",
  "lock.acquired",
  "lock.released",
  "lock.expired",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z
  .object({
    event_id: UuidSchema,
    project_id: UuidSchema,
    sequence: SequenceNumberSchema,
    type: EventTypeSchema,
    actor_id: z.string().trim().min(1).max(100),
    occurred_at: UtcIsoDateSchema,
    payload_version: z.literal(1),
    payload: z.record(z.unknown()).refine((p) => {
      const str = JSON.stringify(p);
      const bytes =
        typeof Buffer !== "undefined"
          ? Buffer.byteLength(str, "utf8")
          : new TextEncoder().encode(str).length;
      return bytes <= MAX_EVENT_PAYLOAD_BYTES;
    }, `Event payload cannot exceed ${MAX_EVENT_PAYLOAD_BYTES} bytes (64 KiB)`),
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
