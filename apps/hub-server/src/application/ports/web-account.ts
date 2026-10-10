import type { WebIdentity } from "./web-access.js";

export interface WebAccountRecord {
  user_id: string;
  salt: string;
  password_hash: string;
}
export interface WebAccountRepository {
  credential(userId: string): WebAccountRecord | undefined;
  byUsername(username: string): WebAccountRecord | undefined;
  insert(record: WebAccountRecord, now: string): void;
  projects(userId: string): { project_id: string; name: string }[];
  active(identity: WebIdentity, now: string): boolean;
  reset(userId: string, now: string): boolean;
}
