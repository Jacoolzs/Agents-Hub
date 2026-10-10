import type { DatabaseSync } from "node:sqlite";
import { BROWSER_AUDIENCE } from "@agents-hub/shared";
import type { WebIdentity } from "../../application/ports/web-access.js";
import type {
  WebAccountRecord,
  WebAccountRepository,
} from "../../application/ports/web-account.js";

export class SqliteWebAccountRepository implements WebAccountRepository {
  constructor(private db: DatabaseSync) {}
  credential(userId: string) {
    return this.db
      .prepare("SELECT user_id, salt, password_hash FROM web_accounts WHERE user_id = ?")
      .get(userId) as WebAccountRecord | undefined;
  }
  byUsername(username: string) {
    return this.db
      .prepare(
        "SELECT a.user_id, a.salt, a.password_hash FROM web_accounts a JOIN users u ON u.user_id = a.user_id WHERE u.username = ?",
      )
      .get(username) as WebAccountRecord | undefined;
  }
  insert(record: WebAccountRecord, now: string) {
    this.db
      .prepare(
        "INSERT INTO web_accounts (user_id, salt, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(record.user_id, record.salt, record.password_hash, now);
  }
  projects(userId: string) {
    return this.db
      .prepare(
        "SELECT p.project_id, p.name FROM projects p JOIN memberships m ON m.project_id = p.project_id WHERE m.user_id = ? ORDER BY p.name, p.project_id",
      )
      .all(userId) as ReturnType<WebAccountRepository["projects"]>;
  }
  active(identity: WebIdentity, now: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM auth_tokens WHERE token_id = ? AND subject = ? AND audience = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(identity.tokenId, identity.userId, BROWSER_AUDIENCE, now);
  }
  reset(userId: string, now: string) {
    if (!this.db.prepare("SELECT 1 FROM users WHERE user_id = ?").get(userId)) return false;
    this.db.prepare("DELETE FROM web_accounts WHERE user_id = ?").run(userId);
    this.db
      .prepare(
        "UPDATE auth_tokens SET revoked_at = ? WHERE subject = ? AND audience = ? AND revoked_at IS NULL",
      )
      .run(now, userId, BROWSER_AUDIENCE);
    this.db
      .prepare(
        "UPDATE web_entries SET revoked_at = ? WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
      )
      .run(now, userId);
    return true;
  }
}
