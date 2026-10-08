import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, IdempotencyKeySchema } from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class IdempotencyService {
  constructor(
    private db: DatabaseSync,
    private eventBus: SqliteEventBus,
  ) {}

  public execute<T>(
    userId: string,
    projectId: string,
    operation: string,
    key: unknown,
    payload: unknown,
    command: () => T,
  ): T {
    if (key === undefined) return command();
    const parsed = IdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid idempotency key");
    const hash = createHash("sha256").update(canonical(payload)).digest("hex");
    return this.eventBus.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("DELETE FROM idempotency_records WHERE expires_at <= ?").run(now);
      const row = this.db
        .prepare(
          "SELECT request_hash, result FROM idempotency_records WHERE user_id = ? AND project_id = ? AND operation = ? AND key = ?",
        )
        .get(userId, projectId, operation, parsed.data) as
        | { request_hash: string; result: string }
        | undefined;
      if (row) {
        if (row.request_hash !== hash)
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different request",
          );
        return JSON.parse(row.result) as T;
      }
      const result = command();
      this.db
        .prepare("INSERT INTO idempotency_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          userId,
          projectId,
          operation,
          parsed.data,
          hash,
          JSON.stringify(result ?? null),
          now,
          new Date(Date.now() + 86400000).toISOString(),
        );
      return result;
    });
  }
}
