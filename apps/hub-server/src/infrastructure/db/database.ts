import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INITIAL_MIGRATION_SQL } from "./migrations.js";

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

  // Run migrations
  db.exec(INITIAL_MIGRATION_SQL);

  return db;
}
