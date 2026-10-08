import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "@agents-hub/shared";

/**
 * Creates a consistent snapshot backup of the SQLite database synchronously
 * using the SQLite VACUUM INTO command.
 *
 * @param db Active DatabaseSync instance.
 * @param destinationFilePath Absolute or relative path for the backup file.
 */
export function backupDatabase(db: DatabaseSync, destinationFilePath: string): void {
  const dir = path.dirname(destinationFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Preserve previous backups and the live database; destinations must be new.
  if (fs.existsSync(destinationFilePath)) {
    throw new AppError("INVALID_INPUT", "Backup destination already exists");
  }

  try {
    // Escape single quotes for SQL string literal
    const sanitizedPath = destinationFilePath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${sanitizedPath}';`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError("INTERNAL_ERROR", `Failed to create database backup: ${message}`);
  }
}
