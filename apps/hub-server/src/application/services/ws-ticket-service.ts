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
      UPDATE ws_tickets
      SET used_at = ?
      WHERE ticket_hash = ?
        AND used_at IS NULL
        AND expires_at > ?
      RETURNING user_id, project_id, session_id
    `);

    const row = stmt.get(now, ticketHash, now) as
      | {
          user_id: string;
          project_id: string;
          session_id: string;
        }
      | undefined;

    if (!row) {
      throw new AppError("UNAUTHENTICATED", "Invalid, expired, or already used WebSocket ticket");
    }

    if (row.project_id !== expectedProjectId || row.session_id !== expectedSessionId) {
      throw new AppError("FORBIDDEN", "WebSocket ticket does not match project or session");
    }

    return {
      userId: row.user_id,
      projectId: row.project_id,
      sessionId: row.session_id,
    };
  }
}
