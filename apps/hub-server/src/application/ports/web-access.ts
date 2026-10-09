import type { MembershipRole } from "@agents-hub/shared";

export interface WebIdentity {
  userId: string;
  tokenId: string;
  expiresAt: string;
  projectId?: string;
}
export interface WebAccessRepository {
  user(userId: string): { user_id: string; username: string } | undefined;
  project(projectId: string): { project_id: string; name: string } | undefined;
  insertEntry(entry: {
    entry_id: string;
    secret_hash: string;
    user_id: string;
    project_id: string;
    expires_at: string;
    created_at: string;
  }): void;
  consumeEntry(
    hash: string,
    now: string,
  ): { entry_id: string; user_id: string; project_id: string } | undefined;
  findEntry(
    hash: string,
    now: string,
  ): { user_id: string; project_id: string; expires_at: string } | undefined;
}
export interface WebSessionAuthority {
  checkProjectPermission(userId: string, projectId: string): MembershipRole;
  issue(userId: string, projectId: string): { secret: string; identity: WebIdentity };
  revoke(tokenId: string, userId: string): boolean;
}
