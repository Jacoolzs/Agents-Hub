import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "@agents-hub/shared";

export interface WsTicketPayload {
  userId: string;
  projectId: string;
  sessionId: string;
}

export class WsTicketService {
  constructor(private readonly db: DatabaseSync) {}

  public static hashTicket(ticket: string): string {
    return crypto.createHash("sha256").update(ticket).digest("hex");
  }

  public createTicket(
    userId: string,
    projectId: string,
    sessionId: string,
    ttlSeconds = 30,
  ): string {
    const rawTicket = `wst_${crypto.randomBytes(24).toString("base64url")}`;
    const ticketHash = WsTicketService.hashTicket(rawTicket);
    const ticketId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    this.db
      .prepare(`
      INSERT INTO ws_tickets (ticket_id, ticket_hash, user_id, project_id, session_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(ticketId, ticketHash, userId, projectId, sessionId, expiresAt, now.toISOString());

    return rawTicket;
  }

  public consumeTicket(
    rawTicket: string,
    expectedProjectId: string,
    expectedSessionId: string,
  ): WsTicketPayload {
    const ticketHash = WsTicketService.hashTicket(rawTicket);
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      SELECT user_id, project_id, session_id, expires_at, used_at
      FROM ws_tickets
      WHERE ticket_hash = ?
    `);

    const row = stmt.get(ticketHash) as
      | {
          user_id: string;
          project_id: string;
          session_id: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;

    if (!row) {
      throw new AppError("UNAUTHENTICATED", "Invalid or unknown WebSocket ticket");
    }

    if (row.used_at !== null) {
      throw new AppError("UNAUTHENTICATED", "WebSocket ticket has already been used");
    }

    if (row.expires_at <= now) {
      throw new AppError("UNAUTHENTICATED", "WebSocket ticket has expired");
    }

    if (row.project_id !== expectedProjectId || row.session_id !== expectedSessionId) {
      throw new AppError("FORBIDDEN", "WebSocket ticket does not match project or session");
    }

    // Atomically mark ticket as used
    const updateStmt = this.db.prepare(`
      UPDATE ws_tickets
      SET used_at = ?
      WHERE ticket_hash = ? AND used_at IS NULL
    `);

    const result = updateStmt.run(now, ticketHash) as { changes?: number };
    if (!result.changes || result.changes === 0) {
      throw new AppError("UNAUTHENTICATED", "WebSocket ticket already consumed");
    }

    return {
      userId: row.user_id,
      projectId: row.project_id,
      sessionId: row.session_id,
    };
  }
}
