import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, type MembershipRole } from "@agents-hub/shared";

export interface AuthContext {
  userId: string;
  projectId?: string;
  role?: MembershipRole;
  scopes?: string[];
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
  ): string {
    const rawToken = `ah_${crypto.randomBytes(24).toString("base64url")}`;
    const tokenHash = AuthService.hashToken(rawToken);
    const tokenId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    this.db
      .prepare(`
      INSERT INTO auth_tokens (token_id, token_hash, subject, audience, scopes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        tokenId,
        tokenHash,
        subject,
        audience,
        JSON.stringify(scopes),
        expiresAt,
        now.toISOString(),
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
    };
  }

  public checkProjectPermission(userId: string, projectId: string): MembershipRole {
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

    return row.role;
  }
}
