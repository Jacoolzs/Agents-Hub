import { z } from "zod";

export const UuidSchema = z.string().uuid();

export type Uuid = z.infer<typeof UuidSchema>;

export function generateId(): string {
  return crypto.randomUUID();
}
