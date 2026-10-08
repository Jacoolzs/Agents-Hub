import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "@agents-hub/shared";

/**
 * Creates an instantaneous, consistent online snapshot backup of the SQLite database
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

  // If destination file already exists, remove it first as VACUUM INTO requires a non-existent file
  if (fs.existsSync(destinationFilePath)) {
    fs.unlinkSync(destinationFilePath);
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
