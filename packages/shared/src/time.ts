import { z } from "zod";

// Strict UTC ISO-8601 string: e.g. "2026-10-07T18:30:00.000Z" or ending in "Z"
export const UtcIsoDateSchema = z
  .string()
  .datetime({ offset: false, message: "Date must be an ISO 8601 UTC string ending in 'Z'" });

export type UtcIsoDate = z.infer<typeof UtcIsoDateSchema>;

export function nowUtc(): string {
  return new Date().toISOString();
}
