import type { DatabaseSync } from "node:sqlite";
import type {
  IdempotencyIdentity,
  IdempotencyRecord,
  IdempotencyRepository,
} from "../../application/ports/persistence.js";

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: DatabaseSync) {}

  public purgeExpired(now: string): void {
    this.db.prepare("DELETE FROM idempotency_records WHERE expires_at <= ?").run(now);
  }
  public find(identity: IdempotencyIdentity): IdempotencyRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT request_hash, result, created_at, expires_at FROM idempotency_records WHERE user_id = ? AND project_id = ? AND operation = ? AND key = ?",
      )
      .get(identity.user_id, identity.project_id, identity.operation, identity.key) as
      | (Omit<IdempotencyRecord, "result"> & { result: string })
      | undefined;
    return row ? { ...row, result: JSON.parse(row.result) } : undefined;
  }
  public insert(identity: IdempotencyIdentity, record: IdempotencyRecord): void {
    this.db
      .prepare("INSERT INTO idempotency_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        identity.user_id,
        identity.project_id,
        identity.operation,
        identity.key,
        record.request_hash,
        JSON.stringify(record.result ?? null),
        record.created_at,
        record.expires_at,
      );
  }
}
