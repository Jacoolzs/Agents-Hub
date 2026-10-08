import type {
  AgentSession,
  AgentSessionStatus,
  EventEnvelope,
  EventType,
  Membership,
  MembershipRole,
  Message,
  Project,
  StatusReport,
  WorkspaceLock,
} from "@agents-hub/shared";

/** Synchronous callbacks only: transaction state must not cross an await. */
export interface UnitOfWork {
  transaction<T>(work: () => T): T;
}

export interface DomainEvents extends UnitOfWork {
  recordEvent(
    projectId: string,
    actorId: string,
    type: EventType,
    payload: Record<string, unknown>,
  ): EventEnvelope;
}

export interface AuditEntry {
  audit_id: string;
  project_id?: string | undefined;
  actor_id: string;
  action: string;
  resource: string;
  result: "success" | "failure";
  request_id: string;
  created_at: string;
}
export interface AuditRepository {
  insert(entry: AuditEntry): void;
}
export interface StatusRepository {
  insert(report: StatusReport): void;
  latestByProject(projectId: string): StatusReport[];
}
export interface MessageRepository {
  recipientExists(projectId: string, agentId: string): boolean;
  insert(message: Message): void;
  listByProject(projectId: string, channel: string | undefined, limit: number): Message[];
}

export interface SessionRepository {
  findByAgent(projectId: string, agentId: string): AgentSession | undefined;
  findById(sessionId: string): AgentSession | undefined;
  insert(session: AgentSession, instanceId?: string): void;
  instanceId(sessionId: string): string | undefined;
  rotateSession(
    sessionId: string,
    replacementId: string,
    seenAt: string,
    instanceId?: string,
  ): void;
  updatePresence(
    projectId: string,
    agentId: string,
    status: AgentSessionStatus,
    seenAt: string,
  ): boolean;
  confirmCursor(projectId: string, agentId: string, cursor: string, sequence: number): void;
  activeByProject(projectId: string): AgentSession[];
  connected(): AgentSession[];
  setStatus(sessionId: string, status: AgentSessionStatus): void;
}

export interface LockRepository {
  insert(lock: WorkspaceLock): void;
  findById(projectId: string, lockId: string): WorkspaceLock | undefined;
  activeByProject(projectId: string, now: string): WorkspaceLock[];
  expired(now: string, projectId?: string): WorkspaceLock[];
  remove(lockId: string): void;
  updatePaths(lockId: string, paths: string[]): void;
  renew(lockId: string, expiresAt: string, ttlSeconds: number): void;
}

export interface IdempotencyIdentity {
  user_id: string;
  project_id: string;
  operation: string;
  key: string;
}
export interface IdempotencyRecord {
  request_hash: string;
  result: unknown;
  created_at: string;
  expires_at: string;
}
export interface IdempotencyRepository {
  purgeExpired(now: string): void;
  find(identity: IdempotencyIdentity): IdempotencyRecord | undefined;
  insert(identity: IdempotencyIdentity, record: IdempotencyRecord): void;
}

export interface ProjectRepository {
  ensureUser(userId: string, username: string, createdAt: string): void;
  insert(project: Project): void;
  insertMembership(membership: Membership): void;
  find(projectId: string): Project | undefined;
  findMembership(projectId: string, userId: string): Membership | undefined;
}

export interface ProjectAuthorization {
  checkProjectPermission(userId: string, projectId: string, write?: boolean): MembershipRole;
}
export interface InvitationSummary {
  invitation_id: string;
  project_id: string;
  role: MembershipRole;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
}
export interface MembershipRepository {
  userExists(userId: string): boolean;
  memberExists(projectId: string, userId: string): boolean;
  insertInvitation(
    invitation: Omit<InvitationSummary, "revoked_at" | "consumed_at"> & {
      token_hash: string;
      created_by: string;
    },
  ): void;
  invitationRole(projectId: string, invitationId: string): MembershipRole | undefined;
  listInvitations(projectId: string): InvitationSummary[];
  revokeInvitation(projectId: string, invitationId: string, now: string): void;
  consumeInvitation(
    projectId: string,
    userId: string,
    tokenHash: string,
    now: string,
  ): { invitation_id: string; role: MembershipRole } | undefined;
  insertMembership(membership: Membership): void;
  listMembers(projectId: string): Array<Membership & { username: string }>;
  setRole(projectId: string, userId: string, role: MembershipRole): void;
  removeMember(projectId: string, userId: string): void;
  disconnectUserSessions(projectId: string, userId: string): void;
  transferOwnership(projectId: string, userId: string, now: string): void;
}

export interface TicketIdentity {
  userId: string;
  projectId: string;
  sessionId: string;
  tokenId?: string;
}
export interface TicketRepository {
  insert(
    identity: TicketIdentity,
    ticketId: string,
    hash: string,
    createdAt: string,
    expiresAt: string,
  ): void;
  consume(hash: string, now: string): TicketIdentity | undefined;
  cleanup(now: string): void;
}
