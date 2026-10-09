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
  usernameExists(username: string) {
    return !!this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
  }
  insertUser(user: Parameters<WebAccessRepository["insertUser"]>[0]) {
    this.db
      .prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)")
      .run(user.user_id, user.username, user.created_at);
  }
  memberExists(userId: string, projectId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM memberships WHERE user_id = ? AND project_id = ?")
      .get(userId, projectId);
  }
  insertMembership(member: Parameters<WebAccessRepository["insertMembership"]>[0]) {
    this.db
      .prepare(
        "INSERT INTO memberships (membership_id, project_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(member.membership_id, member.project_id, member.user_id, member.role, member.created_at);
  }
  invitations() {
    return this.db
      .prepare(
        "SELECT e.entry_id, e.user_id, u.username, e.project_id, p.name AS project_name, e.pending_role, e.expires_at, e.created_at, e.consumed_at, e.revoked_at FROM web_entries e JOIN users u ON u.user_id = e.user_id JOIN projects p ON p.project_id = e.project_id WHERE e.pending_role IS NOT NULL ORDER BY e.created_at DESC, e.entry_id",
      )
      .all() as ReturnType<WebAccessRepository["invitations"]>;
  }
  revokeInvitation(entryId: string, now: string) {
    return !!this.db
      .prepare(
        "UPDATE web_entries SET revoked_at = ? WHERE entry_id = ? AND pending_role IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL RETURNING entry_id",
      )
      .get(now, entryId);
  }
  insertEntry(entry: Parameters<WebAccessRepository["insertEntry"]>[0]) {
    this.db
      .prepare(
        "INSERT INTO web_entries (entry_id, secret_hash, user_id, project_id, expires_at, created_at, pending_role) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.entry_id,
        entry.secret_hash,
        entry.user_id,
        entry.project_id,
        entry.expires_at,
        entry.created_at,
        entry.pending_role ?? null,
      );
  }
  consumeEntry(hash: string, now: string) {
    return this.db
      .prepare(
        "UPDATE web_entries SET consumed_at = ? WHERE secret_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING entry_id, user_id, project_id, pending_role",
      )
      .get(now, hash, now) as ReturnType<WebAccessRepository["consumeEntry"]>;
  }
  findEntry(hash: string, now: string) {
    return this.db
      .prepare(
        "SELECT entry_id, user_id, project_id, expires_at, pending_role FROM web_entries WHERE secret_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
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
