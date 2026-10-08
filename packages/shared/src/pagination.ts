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

function toBase64Url(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf-8").toString("base64url");
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(base64url: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64url, "base64url").toString("utf-8");
  }
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return atob(base64);
}

export function encodeCursor(sequence: number): string {
  return toBase64Url(sequence.toString());
}

export function decodeCursor(cursor: string): number | null {
  try {
    const raw = fromBase64Url(cursor);
    const num = Number.parseInt(raw, 10);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}
