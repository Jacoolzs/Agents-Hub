import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AppError,
  CreateInvitationInputSchema,
  type MembershipRole,
  nowUtc,
} from "@agents-hub/shared";
import type { AuthService } from "../../http/auth/auth-service.js";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";
import type { AuditService } from "./audit-service.js";

export class MembershipService {
  constructor(
    private db: DatabaseSync,
    private events: SqliteEventBus,
    private auth: AuthService,
    private audit: AuditService,
  ) {}

  private admin(
    userId: string,
    projectId: string,
    targetRole: MembershipRole = "reader",
  ): MembershipRole {
    const role = this.auth.checkProjectPermission(userId, projectId);
    if (role !== "owner" && role !== "maintainer")
      throw new AppError("FORBIDDEN", "Project administrator role required");
    if (role === "maintainer" && !["reader", "collaborator"].includes(targetRole))
      throw new AppError("FORBIDDEN", "Maintainers can only administer readers and collaborators");
    return role;
  }

  public createInvitation(userId: string, projectId: string, input: unknown, requestId: string) {
    const parsed = CreateInvitationInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid invitation role or TTL");
    this.admin(userId, projectId, parsed.data.role);
    const id = crypto.randomUUID();
    const token = `ahi_${crypto.randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + parsed.data.ttl_seconds * 1000).toISOString();
    this.events.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO invitations (invitation_id, project_id, token_hash, created_by, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, projectId, this.hash(token), userId, parsed.data.role, expiresAt, nowUtc());
      this.audit.logAction(userId, "invitation.issue", id, "success", requestId, projectId);
    });
    return {
      invitation_id: id,
      project_id: projectId,
      role: parsed.data.role,
      expires_at: expiresAt,
      token,
    };
  }

  public listInvitations(userId: string, projectId: string) {
    this.admin(userId, projectId);
    return this.db
      .prepare(
        "SELECT invitation_id, project_id, role, expires_at, created_at, revoked_at, consumed_at FROM invitations WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId);
  }

  public revokeInvitation(userId: string, projectId: string, id: string, requestId: string) {
    const row = this.db
      .prepare("SELECT role FROM invitations WHERE project_id = ? AND invitation_id = ?")
      .get(projectId, id) as { role: MembershipRole } | undefined;
    this.admin(userId, projectId, row?.role);
    if (!row) throw new AppError("PROJECT_NOT_FOUND", "Invitation not found");
    this.events.transaction(() => {
      this.db
        .prepare("UPDATE invitations SET revoked_at = ? WHERE project_id = ? AND invitation_id = ?")
        .run(nowUtc(), projectId, id);
      this.audit.logAction(userId, "invitation.revoke", id, "success", requestId, projectId);
    });
  }

  public acceptInvitation(userId: string, projectId: string, token: string, requestId: string) {
    return this.events.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM users WHERE user_id = ?").get(userId))
        throw new AppError(
          "UNAUTHENTICATED",
          "Provision a user identity before accepting an invitation",
        );
      if (
        this.db
          .prepare("SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?")
          .get(projectId, userId)
      )
        throw new AppError("STATE_CONFLICT", "Already a member of this project");
      const now = nowUtc();
      const invitation = this.db
        .prepare(`UPDATE invitations SET consumed_at = ?, consumed_by = ?
        WHERE token_hash = ? AND project_id = ? AND expires_at > ? AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING invitation_id, role`)
        .get(now, userId, this.hash(token), projectId, now) as
        | { invitation_id: string; role: MembershipRole }
        | undefined;
      if (!invitation)
        throw new AppError("UNAUTHENTICATED", "Invalid, expired, revoked or consumed invitation");
      const result = {
        membership_id: crypto.randomUUID(),
        project_id: projectId,
        user_id: userId,
        role: invitation.role,
        created_at: now,
      };
      this.db
        .prepare("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)")
        .run(result.membership_id, projectId, userId, result.role, now);
      this.audit.logAction(
        userId,
        "invitation.accept",
        invitation.invitation_id,
        "success",
        requestId,
        projectId,
      );
      this.events.recordEvent(projectId, userId, "membership.updated", {
        user_id: userId,
        role: result.role,
      });
      return result;
    });
  }

  public listMembers(userId: string, projectId: string) {
    this.auth.checkProjectPermission(userId, projectId);
    return this.db
      .prepare(
        "SELECT m.*, u.username FROM memberships m JOIN users u ON u.user_id = m.user_id WHERE project_id = ?",
      )
      .all(projectId);
  }

  public changeMember(
    userId: string,
    projectId: string,
    targetUserId: string,
    role: MembershipRole | null,
    requestId: string,
  ) {
    return this.events.transaction(() => {
      const target = this.auth.checkProjectPermission(targetUserId, projectId);
      this.admin(userId, projectId, target);
      if (target === "owner" || role === "owner")
        throw new AppError("FORBIDDEN", "Use ownership transfer to change the owner");
      if (role) this.admin(userId, projectId, role);
      if (role)
        this.db
          .prepare("UPDATE memberships SET role = ? WHERE project_id = ? AND user_id = ?")
          .run(role, projectId, targetUserId);
      else {
        this.db
          .prepare("DELETE FROM memberships WHERE project_id = ? AND user_id = ?")
          .run(projectId, targetUserId);
        this.db
          .prepare(
            "UPDATE agent_sessions SET status = 'disconnected' WHERE project_id = ? AND user_id = ?",
          )
          .run(projectId, targetUserId);
      }
      this.audit.logAction(
        userId,
        role ? "membership.role" : "membership.remove",
        targetUserId,
        "success",
        requestId,
        projectId,
      );
      this.events.recordEvent(projectId, userId, "membership.updated", {
        user_id: targetUserId,
        role,
      });
      return { user_id: targetUserId, role };
    });
  }

  public transferOwnership(
    userId: string,
    projectId: string,
    targetUserId: string,
    requestId: string,
  ) {
    return this.events.transaction(() => {
      if (this.admin(userId, projectId) !== "owner")
        throw new AppError("FORBIDDEN", "Only the owner can transfer ownership");
      this.auth.checkProjectPermission(targetUserId, projectId);
      this.db
        .prepare(
          "UPDATE memberships SET role = 'maintainer' WHERE project_id = ? AND role = 'owner'",
        )
        .run(projectId);
      this.db
        .prepare("UPDATE memberships SET role = 'owner' WHERE project_id = ? AND user_id = ?")
        .run(projectId, targetUserId);
      this.db
        .prepare("UPDATE projects SET updated_at = ? WHERE project_id = ?")
        .run(nowUtc(), projectId);
      this.audit.logAction(
        userId,
        "membership.ownership",
        targetUserId,
        "success",
        requestId,
        projectId,
      );
      this.events.recordEvent(projectId, userId, "membership.updated", {
        user_id: targetUserId,
        role: "owner",
      });
      return { user_id: targetUserId, role: "owner" as const };
    });
  }

  private hash(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }
}
