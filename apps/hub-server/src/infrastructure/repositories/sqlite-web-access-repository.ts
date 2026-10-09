import type { DatabaseSync } from "node:sqlite";
import { BROWSER_AUDIENCE } from "@agents-hub/shared";
import type {
  WebAccessRepository,
  WebSessionAuthority,
} from "../../application/ports/web-access.js";
import { AuthService } from "../../http/auth/auth-service.js";
import { PERSONAL_SCOPES } from "./sqlite-administration-repository.js";

export class SqliteWebAccessRepository implements WebAccessRepository {
  constructor(private db: DatabaseSync) {}
  user(id: string) {
    return this.db
      .prepare("SELECT user_id, username FROM users WHERE user_id = ?")
      .get(id) as ReturnType<WebAccessRepository["user"]>;
  }
  project(id: string) {
    return this.db
      .prepare("SELECT project_id, name FROM projects WHERE project_id = ?")
      .get(id) as ReturnType<WebAccessRepository["project"]>;
  }
  insertEntry(entry: Parameters<WebAccessRepository["insertEntry"]>[0]) {
    this.db
      .prepare(
        "INSERT INTO web_entries (entry_id, secret_hash, user_id, project_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.entry_id,
        entry.secret_hash,
        entry.user_id,
        entry.project_id,
        entry.expires_at,
        entry.created_at,
      );
  }
  consumeEntry(hash: string, now: string) {
    return this.db
      .prepare(
        "UPDATE web_entries SET consumed_at = ? WHERE secret_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING entry_id, user_id, project_id",
      )
      .get(now, hash, now) as ReturnType<WebAccessRepository["consumeEntry"]>;
  }
  findEntry(hash: string, now: string) {
    return this.db
      .prepare(
        "SELECT user_id, project_id, expires_at FROM web_entries WHERE secret_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(hash, now) as ReturnType<WebAccessRepository["findEntry"]>;
  }
}
export class SqliteWebSessionAuthority implements WebSessionAuthority {
  private auth: AuthService;
  constructor(db: DatabaseSync) {
    this.auth = new AuthService(db);
  }
  checkProjectPermission(userId: string, projectId: string) {
    return this.auth.checkProjectPermission(userId, projectId);
  }
  issue(userId: string, projectId: string) {
    const secret = this.auth.createToken(
      userId,
      BROWSER_AUDIENCE,
      PERSONAL_SCOPES.filter((s) => s !== "projects:write"),
      28800,
      projectId,
    );
    return { secret, identity: this.auth.verifyToken(secret, BROWSER_AUDIENCE) };
  }
  revoke(id: string, userId: string) {
    return this.auth.revokeToken(id, userId);
  }
}
