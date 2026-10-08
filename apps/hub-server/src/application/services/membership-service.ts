import crypto from "node:crypto";
import {
  AppError,
  CreateInvitationInputSchema,
  type MembershipRole,
  nowUtc,
} from "@agents-hub/shared";
import type {
  DomainEvents,
  MembershipRepository,
  ProjectAuthorization,
} from "../ports/persistence.js";
import type { AuditService } from "./audit-service.js";

export class MembershipService {
  constructor(
    private repository: MembershipRepository,
    private events: DomainEvents,
    private auth: ProjectAuthorization,
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
      this.repository.insertInvitation({
        invitation_id: id,
        project_id: projectId,
        token_hash: this.hash(token),
        created_by: userId,
        role: parsed.data.role,
        expires_at: expiresAt,
        created_at: nowUtc(),
      });
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
    return this.repository.listInvitations(projectId);
  }

  public revokeInvitation(userId: string, projectId: string, id: string, requestId: string) {
    const role = this.repository.invitationRole(projectId, id);
    this.admin(userId, projectId, role);
    if (!role) throw new AppError("PROJECT_NOT_FOUND", "Invitation not found");
    this.events.transaction(() => {
      this.repository.revokeInvitation(projectId, id, nowUtc());
      this.audit.logAction(userId, "invitation.revoke", id, "success", requestId, projectId);
    });
  }

  public acceptInvitation(userId: string, projectId: string, token: string, requestId: string) {
    return this.events.transaction(() => {
      if (!this.repository.userExists(userId))
        throw new AppError(
          "UNAUTHENTICATED",
          "Provision a user identity before accepting an invitation",
        );
      if (this.repository.memberExists(projectId, userId))
        throw new AppError("STATE_CONFLICT", "Already a member of this project");
      const now = nowUtc();
      const invitation = this.repository.consumeInvitation(
        projectId,
        userId,
        this.hash(token),
        now,
      );
      if (!invitation)
        throw new AppError("UNAUTHENTICATED", "Invalid, expired, revoked or consumed invitation");
      const result = {
        membership_id: crypto.randomUUID(),
        project_id: projectId,
        user_id: userId,
        role: invitation.role,
        created_at: now,
      };
      this.repository.insertMembership(result);
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
    return this.repository.listMembers(projectId);
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
      if (role) {
        this.admin(userId, projectId, role);
        this.repository.setRole(projectId, targetUserId, role);
      } else {
        this.repository.removeMember(projectId, targetUserId);
        this.repository.disconnectUserSessions(projectId, targetUserId);
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
      this.repository.transferOwnership(projectId, targetUserId, nowUtc());
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
