import type { DatabaseSync } from "node:sqlite";
import { type EventEnvelope, type EventType, generateId, nowUtc } from "@agents-hub/shared";

export class SqliteEventBus {
  constructor(private readonly db: DatabaseSync) {}

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

    return {
      event_id: eventId,
      project_id: projectId,
      sequence,
      type,
      actor_id: actorId,
      occurred_at: occurredAt,
      payload_version: 1,
      payload,
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
