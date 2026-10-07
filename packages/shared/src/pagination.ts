import { z } from "zod";

// Sequence: monotonic positive integer per project
export const SequenceNumberSchema = z.number().int().positive();
export type SequenceNumber = z.infer<typeof SequenceNumberSchema>;

// Cursor: opaque string encoding sequence
export const CursorSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Cursor must be an opaque URL-safe string");
export type Cursor = z.infer<typeof CursorSchema>;

export function encodeCursor(sequence: number): string {
  return Buffer.from(sequence.toString(), "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf-8");
    const num = Number.parseInt(raw, 10);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}
