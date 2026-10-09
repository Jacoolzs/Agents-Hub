import type { LocalAccess, LocalIssuedAccess, LocalUser, Project } from "@agents-hub/shared";

export interface AdministrationRepository {
  users(): LocalUser[];
  accesses(): LocalAccess[];
  projects(): Project[];
  findUser(id: string): LocalUser | undefined;
  usernameExists(name: string): boolean;
  insertUser(user: LocalUser): void;
  issueAccess(userId: string, ttl: number, projectId?: string): LocalIssuedAccess;
  revokeAccess(tokenId: string): boolean;
}
