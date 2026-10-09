import type { DatabaseSync } from "node:sqlite";
import type { LocalAccess, LocalUser, Project } from "@agents-hub/shared";
import type { AdministrationRepository } from "../../application/ports/administration.js";
import { AuthService } from "../../http/auth/auth-service.js";

export const PERSONAL_SCOPES = [
  "projects:read",
  "projects:write",
  "sessions:write",
  "messages:read",
  "messages:write",
  "locks:read",
  "locks:write",
  "members:read",
  "members:write",
];

export class SqliteAdministrationRepository implements AdministrationRepository {
  private auth: AuthService;
  constructor(private db: DatabaseSync) {
    this.auth = new AuthService(db);
  }
  users() {
    return this.db
      .prepare("SELECT user_id, username, created_at FROM users ORDER BY username")
      .all() as LocalUser[];
  }
  accesses() {
    return this.db
      .prepare(
        "SELECT token_id, audience, subject, project_id, expires_at, created_at, revoked_at FROM auth_tokens ORDER BY created_at DESC",
      )
      .all() as LocalAccess[];
  }
  projects() {
    return this.db
      .prepare(
        "SELECT project_id, name, created_by_user_id, created_at, updated_at FROM projects ORDER BY name",
      )
      .all() as Project[];
  }
  findUser(id: string) {
    return this.db
      .prepare("SELECT user_id, username, created_at FROM users WHERE user_id = ?")
      .get(id) as LocalUser | undefined;
  }
  usernameExists(name: string) {
    return !!this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(name);
  }
  insertUser(user: LocalUser) {
    this.db
      .prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)")
      .run(user.user_id, user.username, user.created_at);
  }
  issueAccess(userId: string, ttl: number, projectId?: string) {
    if (projectId) this.auth.checkProjectPermission(userId, projectId);
    const scopes = projectId
      ? PERSONAL_SCOPES.filter((s) => s !== "projects:write")
      : PERSONAL_SCOPES;
    const token = this.auth.createToken(userId, "agents-hub", scopes, ttl, projectId);
    const verified = this.auth.verifyToken(token);
    return { token, token_id: verified.tokenId, user_id: userId, expires_at: verified.expiresAt };
  }
  revokeAccess(tokenId: string) {
    return this.auth.revokeToken(tokenId);
  }
}
