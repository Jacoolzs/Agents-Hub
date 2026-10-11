import type { DatabaseSync } from "node:sqlite";
import { BROWSER_AUDIENCE } from "@agents-hub/shared";
import type { DeviceAuthority, DeviceRepository } from "../../application/ports/device.js";
import type { WebIdentity } from "../../application/ports/web-access.js";
import { AuthService } from "../../http/auth/auth-service.js";

export class SqliteDeviceRepository implements DeviceRepository {
  constructor(private db: DatabaseSync) {}
  insert(record: Parameters<DeviceRepository["insert"]>[0]) {
    this.db
      .prepare(
        "INSERT INTO device_requests (request_id, label, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        record.request_id,
        record.label,
        record.secret_hash,
        record.expires_at,
        record.created_at,
      );
  }
  pending(id: string, now: string) {
    return this.db
      .prepare(
        "SELECT request_id, label, expires_at FROM device_requests WHERE request_id = ? AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > ?",
      )
      .get(id, now) as ReturnType<DeviceRepository["pending"]>;
  }
  approve(id: string, user: string, project: string, now: string) {
    return !!this.db
      .prepare(
        "UPDATE device_requests SET user_id = ?, project_id = ?, approved_at = ? WHERE request_id = ? AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > ? RETURNING request_id",
      )
      .get(user, project, now, id, now);
  }
  consume(hash: string, now: string) {
    return this.db
      .prepare(
        "UPDATE device_requests SET consumed_at = ? WHERE secret_hash = ? AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ? RETURNING request_id, user_id, project_id",
      )
      .get(now, hash, now) as ReturnType<DeviceRepository["consume"]>;
  }
  attach(id: string, token: string) {
    this.db.prepare("UPDATE device_requests SET token_id = ? WHERE request_id = ?").run(token, id);
  }
  list(user: string, project: string) {
    return this.db
      .prepare(
        "SELECT t.token_id, d.label, t.project_id, t.created_at, t.expires_at, t.revoked_at FROM device_requests d JOIN auth_tokens t ON t.token_id = d.token_id WHERE t.subject = ? AND t.project_id = ? ORDER BY t.created_at DESC, t.token_id",
      )
      .all(user, project) as ReturnType<DeviceRepository["list"]>;
  }
  revoke(token: string, user: string, project: string, now: string) {
    return !!this.db
      .prepare(
        "UPDATE auth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ? AND subject = ? AND project_id = ? AND audience = 'agents-hub' AND EXISTS (SELECT 1 FROM device_requests d WHERE d.token_id = auth_tokens.token_id) RETURNING token_id",
      )
      .get(now, token, user, project);
  }
}
export class SqliteDeviceAuthority implements DeviceAuthority {
  private auth: AuthService;
  constructor(private db: DatabaseSync) {
    this.auth = new AuthService(db);
  }
  humanSessionActive(identity: WebIdentity, now: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM auth_tokens WHERE token_id = ? AND subject = ? AND project_id = ? AND audience = ? AND expires_at = ? AND expires_at > ? AND revoked_at IS NULL",
      )
      .get(
        identity.tokenId,
        identity.userId,
        identity.projectId ?? "",
        BROWSER_AUDIENCE,
        identity.expiresAt,
        now,
      );
  }
  checkProjectPermission(user: string, project: string) {
    return this.auth.checkProjectPermission(user, project);
  }
  issue(user: string, project: string) {
    const token = this.auth.createToken(
      user,
      "agents-hub",
      [
        "projects:read",
        "sessions:write",
        "messages:read",
        "messages:write",
        "locks:read",
        "locks:write",
        "members:read",
      ],
      2592000,
      project,
    );
    const identity = this.auth.verifyToken(token);
    return {
      token,
      token_id: identity.tokenId,
      project_id: project,
      expires_at: identity.expiresAt,
    };
  }
}
