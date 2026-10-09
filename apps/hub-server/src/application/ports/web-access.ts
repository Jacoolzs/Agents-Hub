import type { Membership, MembershipRole, WebInvitationMetadata } from "@agents-hub/shared";

export interface WebEntryRecord {
  entry_id: string;
  user_id: string;
  project_id: string;
  pending_role: "reader" | "collaborator" | "maintainer" | null;
}

export interface WebIdentity {
  userId: string;
  tokenId: string;
  expiresAt: string;
  projectId?: string;
}
export interface WebAccessRepository {
  user(userId: string): { user_id: string; username: string } | undefined;
  project(projectId: string): { project_id: string; name: string } | undefined;
  usernameExists(username: string): boolean;
  insertUser(user: { user_id: string; username: string; created_at: string }): void;
  memberExists(userId: string, projectId: string): boolean;
  insertMembership(membership: Membership): void;
  invitations(): WebInvitationMetadata[];
  revokeInvitation(entryId: string, now: string): boolean;
  insertEntry(entry: {
    entry_id: string;
    secret_hash: string;
    user_id: string;
    project_id: string;
    expires_at: string;
    created_at: string;
    pending_role?: "reader" | "collaborator" | "maintainer";
  }): void;
  consumeEntry(hash: string, now: string): WebEntryRecord | undefined;
  findEntry(hash: string, now: string): (WebEntryRecord & { expires_at: string }) | undefined;
}
export interface WebSessionAuthority {
  checkProjectPermission(userId: string, projectId: string): MembershipRole;
  issue(userId: string, projectId: string): { secret: string; identity: WebIdentity };
  revoke(tokenId: string, userId: string): boolean;
}
