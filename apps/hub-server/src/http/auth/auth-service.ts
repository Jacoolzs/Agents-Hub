import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, BROWSER_AUDIENCE, type MembershipRole } from "@agents-hub/shared";

export interface AuthContext {
  userId: string;
  tokenId: string;
  expiresAt: string;
  projectId?: string;
  role?: MembershipRole;
  scopes?: string[];
  browser?: boolean;
}

export class AuthService {
  constructor(private readonly db: DatabaseSync) {}

  public static hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  public createToken(
    subject: string,
    audience: string,
    scopes: string[] = ["*"],
    ttlSeconds = 3600,
    projectId?: string,
  ): string {
    const rawToken = `ah_${crypto.randomBytes(24).toString("base64url")}`;
    const tokenHash = AuthService.hashToken(rawToken);
    const tokenId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    this.db
      .prepare(`
      INSERT INTO auth_tokens (token_id, token_hash, subject, audience, scopes, expires_at, created_at, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        tokenId,
        tokenHash,
        subject,
        audience,
        JSON.stringify(scopes),
        expiresAt,
        now.toISOString(),
        projectId ?? null,
      );

    return rawToken;
  }

  public verifyToken(rawToken: string, expectedAudience = "agents-hub"): AuthContext {
    const tokenHash = AuthService.hashToken(rawToken);
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      SELECT * FROM auth_tokens
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `);

    const row = stmt.get(tokenHash, now) as
      | {
          subject: string;
          audience: string;
          scopes: string;
          token_id: string;
          expires_at: string;
          project_id: string | null;
        }
      | undefined;

    if (!row) {
      throw new AppError("UNAUTHENTICATED", "Invalid, expired, or revoked authentication token");
    }

    if (row.audience !== expectedAudience) {
      throw new AppError(
        "FORBIDDEN",
        `Token audience '${row.audience}' does not match '${expectedAudience}'`,
      );
    }

    const scopes = JSON.parse(row.scopes) as string[];

    return {
      userId: row.subject,
      scopes,
      tokenId: row.token_id,
      expiresAt: row.expires_at,
      ...(row.project_id ? { projectId: row.project_id } : {}),
    };
  }

  public isTokenActive(tokenId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM auth_tokens WHERE token_id = ? AND revoked_at IS NULL AND expires_at > ? AND audience IN ('agents-hub', ?)",
      )
      .get(tokenId, new Date().toISOString(), BROWSER_AUDIENCE);
  }

  public revokeToken(tokenId: string, userId?: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE auth_tokens SET revoked_at = ? WHERE token_id = ? ${userId ? "AND subject = ?" : ""}`,
      )
      .run(new Date().toISOString(), tokenId, ...(userId ? [userId] : []));
    return result.changes > 0;
  }

  public checkProjectPermission(userId: string, projectId: string, write = false): MembershipRole {
    const stmt = this.db.prepare(`
      SELECT role FROM memberships
      WHERE project_id = ? AND user_id = ?
    `);

    const row = stmt.get(projectId, userId) as { role: MembershipRole } | undefined;
    if (!row) {
      throw new AppError(
        "FORBIDDEN",
        `User ${userId} does not have access to project ${projectId}`,
      );
    }

    if (write && row.role === "reader") {
      throw new AppError("FORBIDDEN", "Read-only members cannot mutate project resources");
    }
    return row.role;
  }
}
