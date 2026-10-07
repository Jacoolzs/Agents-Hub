import type { DatabaseSync } from "node:sqlite";
import { type EventEnvelope, type EventType, generateId, nowUtc } from "@agents-hub/shared";

export type EventListener = (event: EventEnvelope) => void;

export class SqliteEventBus {
  private listeners: Set<EventListener> = new Set();
  private inTransaction = false;
  private pendingEvents: EventEnvelope[] = [];

  constructor(private readonly db: DatabaseSync) {}

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public beginTransaction(): void {
    this.inTransaction = true;
    this.pendingEvents = [];
  }

  public commitTransaction(): void {
    this.inTransaction = false;
    const toDispatch = [...this.pendingEvents];
    this.pendingEvents = [];
    for (const envelope of toDispatch) {
      this.dispatch(envelope);
    }
  }

  public rollbackTransaction(): void {
    this.inTransaction = false;
    this.pendingEvents = [];
  }

  public transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN TRANSACTION;");
    this.beginTransaction();
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      this.commitTransaction();
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      this.rollbackTransaction();
      throw err;
    }
  }

  private dispatch(envelope: EventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {
        // Safe: non-blocking listener failure
      }
    }
  }

  public recordEvent(
    projectId: string,
    actorId: string,
    type: EventType,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    const nextSeqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
      FROM events
      WHERE project_id = ?
    `);
    const row = nextSeqStmt.get(projectId) as { next_seq: number };
    const sequence = row.next_seq;
    const eventId = generateId();
    const occurredAt = nowUtc();

    const insertStmt = this.db.prepare(`
      INSERT INTO events (event_id, project_id, sequence, type, actor_id, occurred_at, payload_version, payload)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);

    insertStmt.run(
      eventId,
      projectId,
      sequence,
      type,
      actorId,
      occurredAt,
      JSON.stringify(payload),
    );

    const envelope: EventEnvelope = {
      event_id: eventId,
      project_id: projectId,
      sequence,
      type,
      actor_id: actorId,
      occurred_at: occurredAt,
      payload_version: 1,
      payload,
    };

    if (this.inTransaction) {
      this.pendingEvents.push(envelope);
    } else {
      this.dispatch(envelope);
    }

    return envelope;
  }

  public getMaxSequence(projectId: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS max_seq
      FROM events
      WHERE project_id = ?
    `);
    const row = stmt.get(projectId) as { max_seq: number } | undefined;
    return row?.max_seq ?? 0;
  }

  public getEventBySequence(projectId: string, sequence: number): EventEnvelope | undefined {
    const stmt = this.db.prepare(`
      SELECT event_id, project_id, sequence, type, actor_id, occurred_at, payload_version, payload
      FROM events
      WHERE project_id = ? AND sequence = ?
    `);
    const row = stmt.get(projectId, sequence) as
      | {
          event_id: string;
          project_id: string;
          sequence: number;
          type: EventType;
          actor_id: string;
          occurred_at: string;
          payload_version: number;
          payload: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      event_id: row.event_id,
      project_id: row.project_id,
      sequence: row.sequence,
      type: row.type,
      actor_id: row.actor_id,
      occurred_at: row.occurred_at,
      payload_version: 1,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
  }

  public getEventsAfter(projectId: string, afterSequence = 0, limit = 50): EventEnvelope[] {
    const stmt = this.db.prepare(`
      SELECT event_id, project_id, sequence, type, actor_id, occurred_at, payload_version, payload
      FROM events
      WHERE project_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);

    const rows = stmt.all(projectId, afterSequence, limit) as Array<{
      event_id: string;
      project_id: string;
      sequence: number;
      type: EventType;
      actor_id: string;
      occurred_at: string;
      payload_version: number;
      payload: string;
    }>;

    return rows.map((r) => ({
      event_id: r.event_id,
      project_id: r.project_id,
      sequence: r.sequence,
      type: r.type,
      actor_id: r.actor_id,
      occurred_at: r.occurred_at,
      payload_version: 1,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }
}
