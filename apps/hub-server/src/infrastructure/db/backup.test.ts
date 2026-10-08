import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase } from "./backup.js";
import { createDatabase } from "./database.js";

describe("SQLite Hot Backup (Phase 6 Operations)", () => {
  const tmpDir = path.join(os.tmpdir(), `agents-hub-backup-test-${Date.now()}`);

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates a consistent hot backup using VACUUM INTO", () => {
    const db = createDatabase(":memory:");
    db.prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)").run(
      "user-backup-1",
      "backup-tester",
      new Date().toISOString(),
    );

    const backupFile = path.join(tmpDir, "backup.sqlite");
    backupDatabase(db, backupFile);

    expect(fs.existsSync(backupFile)).toBe(true);
    expect(fs.statSync(backupFile).size).toBeGreaterThan(0);

    // Open the backup database and verify integrity and contents
    const backupDb = new DatabaseSync(backupFile);
    const row = backupDb
      .prepare("SELECT user_id, username FROM users WHERE user_id = ?")
      .get("user-backup-1") as { user_id: string; username: string };

    expect(row).toBeDefined();
    expect(row.user_id).toBe("user-backup-1");
    expect(row.username).toBe("backup-tester");

    backupDb.close();
    db.close();
  });

  it("preserves an existing backup instead of deleting it", () => {
    const db = createDatabase(":memory:");
    const backupFile = path.join(tmpDir, "existing.sqlite");
    try {
      backupDatabase(db, backupFile);
      const original = fs.readFileSync(backupFile);
      expect(() => backupDatabase(db, backupFile)).toThrow(/already exists/);
      expect(fs.readFileSync(backupFile)).toEqual(original);
    } finally {
      db.close();
    }
  });
});
