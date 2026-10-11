import type { DeviceMetadata } from "@agents-hub/shared";
import type { WebIdentity } from "./web-access.js";

export interface DeviceRequestRecord {
  request_id: string;
  label: string;
  expires_at: string;
}
export interface DeviceRepository {
  insert(record: DeviceRequestRecord & { secret_hash: string; created_at: string }): void;
  pending(requestId: string, now: string): DeviceRequestRecord | undefined;
  approve(requestId: string, userId: string, projectId: string, now: string): boolean;
  consume(
    hash: string,
    now: string,
  ): { request_id: string; user_id: string; project_id: string } | undefined;
  attach(requestId: string, tokenId: string): void;
  list(userId: string, projectId: string): DeviceMetadata[];
  revoke(tokenId: string, userId: string, projectId: string, now: string): boolean;
}
export interface DeviceAuthority {
  humanSessionActive(identity: WebIdentity, now: string): boolean;
  checkProjectPermission(userId: string, projectId: string): unknown;
  issue(
    userId: string,
    projectId: string,
  ): { token: string; token_id: string; project_id: string; expires_at: string };
}
