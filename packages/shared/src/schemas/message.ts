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

export const MessageHistoryPositionSchema = z
  .object({
    created_at: UtcIsoDateSchema,
    message_id: UuidSchema,
  })
  .strict();
export type MessageHistoryPosition = z.infer<typeof MessageHistoryPositionSchema>;

export const MessageHistoryCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, "History cursor must be an opaque URL-safe string");

function encodeBase64Url(value: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64url");
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64url").toString("utf8");
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

export function encodeMessageHistoryCursor(position: MessageHistoryPosition): string {
  const parsed = MessageHistoryPositionSchema.parse(position);
  return encodeBase64Url(JSON.stringify([parsed.created_at, parsed.message_id]));
}

export function decodeMessageHistoryCursor(cursor: string): MessageHistoryPosition | null {
  try {
    if (!MessageHistoryCursorSchema.safeParse(cursor).success) return null;
    const tuple = JSON.parse(decodeBase64Url(cursor)) as unknown;
    if (!Array.isArray(tuple) || tuple.length !== 2) return null;
    const parsed = MessageHistoryPositionSchema.safeParse({
      created_at: tuple[0],
      message_id: tuple[1],
    });
    if (!parsed.success || encodeMessageHistoryCursor(parsed.data) !== cursor) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export const MessageHistoryQuerySchema = z
  .object({
    session_id: UuidSchema,
    before: MessageHistoryCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    channel: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type MessageHistoryQuery = z.infer<typeof MessageHistoryQuerySchema>;

export const MessageHistoryPageSchema = z
  .object({
    messages: z.array(MessageSchema),
    next_cursor: MessageHistoryCursorSchema.nullable(),
    has_more: z.boolean(),
  })
  .strict();
export type MessageHistoryPage = z.infer<typeof MessageHistoryPageSchema>;
