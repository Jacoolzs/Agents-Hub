import type { DatabaseSync } from "node:sqlite";
import type { Membership, MembershipRole } from "@agents-hub/shared";
import type {
  InvitationSummary,
  MembershipRepository,
} from "../../application/ports/persistence.js";

export class SqliteMembershipRepository implements MembershipRepository {
  constructor(private readonly db: DatabaseSync) {}

  public userExists(userId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE user_id = ?").get(userId);
  }
  public memberExists(projectId: string, userId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?")
      .get(projectId, userId);
  }
  public insertInvitation(
    invitation: Omit<InvitationSummary, "revoked_at" | "consumed_at"> & {
      token_hash: string;
      created_by: string;
    },
  ): void {
    this.db
      .prepare(
        "INSERT INTO invitations (invitation_id, project_id, token_hash, created_by, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        invitation.invitation_id,
        invitation.project_id,
        invitation.token_hash,
        invitation.created_by,
        invitation.role,
        invitation.expires_at,
        invitation.created_at,
      );
  }
  public invitationRole(projectId: string, invitationId: string): MembershipRole | undefined {
    return (
      this.db
        .prepare("SELECT role FROM invitations WHERE project_id = ? AND invitation_id = ?")
        .get(projectId, invitationId) as { role: MembershipRole } | undefined
    )?.role;
  }
  public listInvitations(projectId: string): InvitationSummary[] {
    return this.db
      .prepare(
        "SELECT invitation_id, project_id, role, expires_at, created_at, revoked_at, consumed_at FROM invitations WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId) as unknown as InvitationSummary[];
  }
  public revokeInvitation(projectId: string, invitationId: string, now: string): void {
    this.db
      .prepare("UPDATE invitations SET revoked_at = ? WHERE project_id = ? AND invitation_id = ?")
      .run(now, projectId, invitationId);
  }
  public consumeInvitation(
    projectId: string,
    userId: string,
    tokenHash: string,
    now: string,
  ): { invitation_id: string; role: MembershipRole } | undefined {
    return this.db
      .prepare(`UPDATE invitations SET consumed_at = ?, consumed_by = ?
      WHERE token_hash = ? AND project_id = ? AND expires_at > ? AND consumed_at IS NULL AND revoked_at IS NULL
      RETURNING invitation_id, role`)
      .get(now, userId, tokenHash, projectId, now) as
      | { invitation_id: string; role: MembershipRole }
      | undefined;
  }
  public insertMembership(membership: Membership): void {
    this.db
      .prepare("INSERT INTO memberships VALUES (?, ?, ?, ?, ?)")
      .run(
        membership.membership_id,
        membership.project_id,
        membership.user_id,
        membership.role,
        membership.created_at,
      );
  }
  public listMembers(projectId: string): Array<Membership & { username: string }> {
    return this.db
      .prepare(
        "SELECT m.*, u.username FROM memberships m JOIN users u ON u.user_id = m.user_id WHERE project_id = ?",
      )
      .all(projectId) as unknown as Array<Membership & { username: string }>;
  }
  public setRole(projectId: string, userId: string, role: MembershipRole): void {
    this.db
      .prepare("UPDATE memberships SET role = ? WHERE project_id = ? AND user_id = ?")
      .run(role, projectId, userId);
  }
  public removeMember(projectId: string, userId: string): void {
    this.db
      .prepare("DELETE FROM memberships WHERE project_id = ? AND user_id = ?")
      .run(projectId, userId);
  }
  public disconnectUserSessions(projectId: string, userId: string): void {
    this.db
      .prepare(
        "UPDATE agent_sessions SET status = 'disconnected' WHERE project_id = ? AND user_id = ?",
      )
      .run(projectId, userId);
  }
  public transferOwnership(projectId: string, userId: string, now: string): void {
    this.db
      .prepare("UPDATE memberships SET role = 'maintainer' WHERE project_id = ? AND role = 'owner'")
      .run(projectId);
    this.setRole(projectId, userId, "owner");
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE project_id = ?").run(now, projectId);
  }
}
