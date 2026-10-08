import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeCursor } from "@agents-hub/shared";
import { MIGRATIONS } from "./migrations.js";

export function createDatabase(dbPath = ":memory:"): DatabaseSync {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // WAL mode for concurrency and performance (in disk databases)
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Run migrations
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const migration of MIGRATIONS) {
    if (
      db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version)
    )
      continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(migration.sql);
      if (migration.version === 2) {
        const rows = db
          .prepare("SELECT session_id, last_cursor FROM agent_sessions")
          .all() as Array<{ session_id: string; last_cursor: string | null }>;
        for (const row of rows)
          db.prepare("UPDATE agent_sessions SET last_sequence = ? WHERE session_id = ?").run(
            row.last_cursor ? (decodeCursor(row.last_cursor) ?? 0) : 0,
            row.session_id,
          );
      }
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      db.close();
      throw error;
    }
  }

  return db;
}
