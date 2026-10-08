import type { DatabaseSync } from "node:sqlite";
import {
  AppError,
  type EventEnvelope,
  type EventType,
  encodeCursor,
  generateId,
  nowUtc,
} from "@agents-hub/shared";

export type EventListener = (event: EventEnvelope) => void;
import type { DomainEvents } from "../../application/ports/persistence.js";

export class SqliteEventBus implements DomainEvents {
  private listeners: Set<EventListener> = new Set();
  private inTransaction = false;
  private pendingEvents: EventEnvelope[] = [];
  private savepoint = 0;

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
    if (this.inTransaction) {
      const name = `nested_${++this.savepoint}`;
      const pendingLength = this.pendingEvents.length;
      this.db.exec(`SAVEPOINT ${name};`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${name};`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
        this.pendingEvents.length = pendingLength;
        throw error;
      }
    }
    this.db.exec("BEGIN IMMEDIATE;");
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
    const row = this.db
      .prepare(`INSERT INTO project_sequences (project_id, sequence) VALUES (?, 1)
      ON CONFLICT(project_id) DO UPDATE SET sequence = sequence + 1 RETURNING sequence`)
      .get(projectId) as { sequence: number };
    const sequence = row.sequence;
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
    const row = this.db
      .prepare("SELECT sequence FROM project_sequences WHERE project_id = ?")
      .get(projectId) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  public getRetentionBoundary(projectId: string): number {
    const row = this.db
      .prepare("SELECT retained_after FROM project_sequences WHERE project_id = ?")
      .get(projectId) as { retained_after: number } | undefined;
    return row?.retained_after ?? 0;
  }

  public assertCursorAvailable(projectId: string, sequence: number): void {
    const boundary = this.getRetentionBoundary(projectId);
    if (sequence < boundary)
      throw new AppError(
        "CURSOR_EXPIRED",
        "Parte del historial ya no está disponible. Revisa el estado actual y acepta la pérdida antes de continuar.",
        undefined,
        {
          resume_cursor: encodeCursor(boundary),
          recovery_path: `/v1/projects/${projectId}/inbox/recovery`,
        },
      );
    if (sequence > this.getMaxSequence(projectId))
      throw new AppError("CURSOR_INVALID", "Cursor exceeds the project sequence");
  }

  public pruneEventsBefore(before: string): number {
    return this.transaction(() => {
      const projects = this.db
        .prepare(
          "SELECT project_id, MAX(sequence) AS boundary FROM events WHERE occurred_at < ? GROUP BY project_id",
        )
        .all(before) as Array<{ project_id: string; boundary: number }>;
      let removed = 0;
      for (const project of projects) {
        this.db
          .prepare(
            "UPDATE project_sequences SET retained_after = MAX(retained_after, ?) WHERE project_id = ?",
          )
          .run(project.boundary, project.project_id);
        removed += Number(
          this.db
            .prepare("DELETE FROM events WHERE project_id = ? AND sequence <= ?")
            .run(project.project_id, project.boundary).changes,
        );
      }
      return removed;
    });
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
