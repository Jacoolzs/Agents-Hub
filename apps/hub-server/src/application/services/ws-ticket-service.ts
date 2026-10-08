import crypto from "node:crypto";
import { AppError } from "@agents-hub/shared";
import type { TicketIdentity, TicketRepository } from "../ports/persistence.js";

export type WsTicketPayload = TicketIdentity;

export class WsTicketService {
  constructor(private readonly repository: TicketRepository) {}

  public static hashTicket(ticket: string): string {
    return crypto.createHash("sha256").update(ticket).digest("hex");
  }

  public createTicket(
    userId: string,
    projectId: string,
    sessionId: string,
    ttlSeconds = 30,
    tokenId?: string,
  ): string {
    const raw = `wst_${crypto.randomBytes(24).toString("base64url")}`;
    const now = new Date();
    this.repository.insert(
      { userId, projectId, sessionId, ...(tokenId ? { tokenId } : {}) },
      crypto.randomUUID(),
      WsTicketService.hashTicket(raw),
      now.toISOString(),
      new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    );
    return raw;
  }

  public consumeTicket(
    rawTicket: string,
    expectedProjectId: string,
    expectedSessionId: string,
  ): WsTicketPayload {
    const identity = this.repository.consume(
      WsTicketService.hashTicket(rawTicket),
      new Date().toISOString(),
    );
    if (!identity)
      throw new AppError("UNAUTHENTICATED", "Invalid, expired, or already used WebSocket ticket");
    if (identity.projectId !== expectedProjectId || identity.sessionId !== expectedSessionId)
      throw new AppError("FORBIDDEN", "WebSocket ticket does not match project or session");
    return identity;
  }

  public cleanup(): void {
    this.repository.cleanup(new Date().toISOString());
  }
}
