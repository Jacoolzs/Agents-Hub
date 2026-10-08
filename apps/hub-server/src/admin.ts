import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "@agents-hub/config";
import { UuidSchema } from "@agents-hub/shared";
import { AuditService } from "./application/services/audit-service.js";
import { AuthService } from "./http/auth/auth-service.js";
import { backupDatabase } from "./infrastructure/db/backup.js";
import { createDatabase } from "./infrastructure/db/database.js";
import { SqliteAuditRepository } from "./infrastructure/repositories/sqlite-audit-repository.js";

const DEFAULT_SCOPES = [
  "projects:read",
  "projects:write",
  "sessions:write",
  "messages:read",
  "messages:write",
  "locks:read",
  "locks:write",
  "members:read",
  "members:write",
];

export function runAdmin(args: string[]): unknown {
  const config = loadConfig();
  const [command, value, extra] = args;
  if (command === "restore") {
    if (!value || !extra) throw new Error("Usage: restore <backup-path> <new-db-path>");
    const source = path.resolve(value);
    const target = path.resolve(extra);
    if (
      source === target ||
      existsSync(target) ||
      existsSync(`${target}-wal`) ||
      existsSync(`${target}-shm`)
    )
      throw new Error("Restore destination must be new");
    const check = new DatabaseSync(source, { readOnly: true });
    try {
      if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new Error("Backup integrity check failed");
    } finally {
      check.close();
    }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    return {
      database: target,
      status: "restored",
      next_step: "Start the Hub with DATABASE_URL set to this new path",
    };
  }
  if (
    !["create-user", "issue-token", "revoke-token", "backup", "list-users"].includes(command ?? "")
  )
    throw new Error(
      "Commands: create-user <username>, issue-token <user-id> [project-id], revoke-token <token-id>, backup <new-path>, restore <backup> <new-db>, list-users",
    );
  const db = createDatabase(config.DATABASE_URL);
  const auth = new AuthService(db);
  const audit = new AuditService(new SqliteAuditRepository(db));
  try {
    if (command === "create-user") {
      if (!value || !/^[A-Za-z0-9._-]{1,80}$/.test(value))
        throw new Error("Username must contain 1–80 letters, digits, dot, underscore or hyphen");
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(value))
        throw new Error("Username already exists; use list-users and issue-token");
      const userId = crypto.randomUUID();
      db.prepare("INSERT INTO users VALUES (?, ?, ?)").run(userId, value, new Date().toISOString());
      const token = auth.createToken(
        userId,
        "agents-hub",
        DEFAULT_SCOPES,
        config.AUTH_TOKEN_TTL_SECONDS,
      );
      audit.logAction(userId, "user.provision", userId, "success", crypto.randomUUID());
      audit.logAction(
        userId,
        "token.issue",
        auth.verifyToken(token).tokenId,
        "success",
        crypto.randomUUID(),
      );
      return { user_id: userId, username: value, token, expires_in: config.AUTH_TOKEN_TTL_SECONDS };
    }
    if (command === "issue-token") {
      if (!value || !db.prepare("SELECT 1 FROM users WHERE user_id = ?").get(value))
        throw new Error("Unknown user ID");
      if (extra) {
        UuidSchema.parse(extra);
        auth.checkProjectPermission(value, extra);
      }
      const scopes = extra ? DEFAULT_SCOPES.filter((s) => s !== "projects:write") : DEFAULT_SCOPES;
      const token = auth.createToken(
        value,
        "agents-hub",
        scopes,
        config.AUTH_TOKEN_TTL_SECONDS,
        extra,
      );
      audit.logAction(
        value,
        "token.issue",
        auth.verifyToken(token).tokenId,
        "success",
        crypto.randomUUID(),
        extra,
      );
      return {
        user_id: value,
        token,
        expires_in: config.AUTH_TOKEN_TTL_SECONDS,
        ...(extra ? { project_id: extra } : {}),
      };
    }
    if (command === "revoke-token") {
      if (!value || !auth.revokeToken(value)) throw new Error("Unknown token ID");
      audit.logAction("local-admin", "token.revoke", value, "success", crypto.randomUUID());
      return { revoked: true };
    }
    if (command === "backup") {
      if (!value) throw new Error("Specify a new backup path");
      backupDatabase(db, path.resolve(value));
      return { backup: path.resolve(value), status: "created" };
    }
    return db.prepare("SELECT user_id, username, created_at FROM users").all();
  } finally {
    db.close();
  }
}

if (process.env.NODE_ENV !== "test") {
  try {
    process.stdout.write(`${JSON.stringify(runAdmin(process.argv.slice(2)), null, 2)}\n`);
  } catch {
    console.error(
      "Administrative command failed. Check command arguments, DB path and existing resources.",
    );
    process.exitCode = 1;
  }
}
