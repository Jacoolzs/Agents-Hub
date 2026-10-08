import { z } from "zod";
import { UuidSchema } from "../ids.js";
import { UtcIsoDateSchema } from "../time.js";

// Max message body: 16 KiB (16384 bytes)
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024;

export const MessagePrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

export const MessageSchema = z
  .object({
    message_id: UuidSchema,
    project_id: UuidSchema,
    sender_id: z.string().trim().min(1).max(100),
    recipient_agent_ids: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    channel: z.string().trim().min(1).max(100).default("general"),
    body: z
      .string()
      .min(1)
      .refine((val) => {
        const bytes =
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(val, "utf8")
            : new TextEncoder().encode(val).length;
        return bytes <= MAX_MESSAGE_BODY_BYTES;
      }, `Message body cannot exceed ${MAX_MESSAGE_BODY_BYTES} bytes (16 KiB)`),
    priority: MessagePrioritySchema.default("normal"),
    correlation_id: z.string().trim().min(1).max(100).optional(),
    created_at: UtcIsoDateSchema,
  })
  .strict();

export type Message = z.infer<typeof MessageSchema>;

export const SendMessageInputSchema = z
  .object({
    channel: z.string().trim().min(1).max(100).default("general"),
    recipient_agent_ids: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    body: z
      .string()
      .min(1)
      .refine((val) => {
        const bytes =
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(val, "utf8")
            : new TextEncoder().encode(val).length;
        return bytes <= MAX_MESSAGE_BODY_BYTES;
      }, `Message body cannot exceed ${MAX_MESSAGE_BODY_BYTES} bytes (16 KiB)`),
    priority: MessagePrioritySchema.optional(),
    correlation_id: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
