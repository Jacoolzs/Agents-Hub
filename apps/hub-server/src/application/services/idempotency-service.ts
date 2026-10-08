import { createHash } from "node:crypto";
import { AppError, IdempotencyKeySchema } from "@agents-hub/shared";
import type { IdempotencyRepository, UnitOfWork } from "../ports/persistence.js";

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
    private repository: IdempotencyRepository,
    private eventBus: UnitOfWork,
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
      this.repository.purgeExpired(now);
      const identity = { user_id: userId, project_id: projectId, operation, key: parsed.data };
      const row = this.repository.find(identity);
      if (row) {
        if (row.request_hash !== hash)
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different request or an earlier command contract",
          );
        return row.result as T;
      }
      const result = command();
      this.repository.insert(identity, {
        request_hash: hash,
        result,
        created_at: now,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
      return result;
    });
  }
}
