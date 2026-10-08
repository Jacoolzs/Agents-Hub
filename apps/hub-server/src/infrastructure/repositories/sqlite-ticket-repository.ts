import type { DatabaseSync } from "node:sqlite";
import type { TicketIdentity, TicketRepository } from "../../application/ports/persistence.js";

export class SqliteTicketRepository implements TicketRepository {
  constructor(private readonly db: DatabaseSync) {}

  public insert(
    identity: TicketIdentity,
    ticketId: string,
    hash: string,
    createdAt: string,
    expiresAt: string,
  ): void {
    this.db
      .prepare(`INSERT INTO ws_tickets (ticket_id, ticket_hash, user_id, project_id, session_id, expires_at, created_at, auth_token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ticketId,
        hash,
        identity.userId,
        identity.projectId,
        identity.sessionId,
        expiresAt,
        createdAt,
        identity.tokenId ?? null,
      );
  }
  public consume(hash: string, now: string): TicketIdentity | undefined {
    const row = this.db
      .prepare(`UPDATE ws_tickets SET used_at = ?
      WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING user_id, project_id, session_id, auth_token_id`)
      .get(now, hash, now) as
      | { user_id: string; project_id: string; session_id: string; auth_token_id: string | null }
      | undefined;
    return row
      ? {
          userId: row.user_id,
          projectId: row.project_id,
          sessionId: row.session_id,
          ...(row.auth_token_id ? { tokenId: row.auth_token_id } : {}),
        }
      : undefined;
  }
  public cleanup(now: string): void {
    this.db.prepare("DELETE FROM ws_tickets WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
  }
}
