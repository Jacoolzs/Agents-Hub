import type { DatabaseSync } from "node:sqlite";
import { AppError, type Membership, type Project, generateId, nowUtc } from "@agents-hub/shared";
import type { SqliteEventBus } from "../../infrastructure/event-bus/event-bus.js";

export class ProjectService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventBus: SqliteEventBus,
  ) {}

  public createProject(
    name: string,
    userId: string,
    username = "user",
  ): { project: Project; membership: Membership } {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new AppError("INVALID_INPUT", "Project name cannot be empty");
    }

    // Ensure user exists
    const userStmt = this.db.prepare("SELECT user_id FROM users WHERE user_id = ?");
    if (!userStmt.get(userId)) {
      const uniqueUsername = `${username}-${userId.slice(0, 8)}`;
      this.db
        .prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)")
        .run(userId, uniqueUsername, nowUtc());
    }

    const projectId = generateId();
    const membershipId = generateId();
    const now = nowUtc();

    this.db.exec("BEGIN TRANSACTION;");
    try {
      this.db
        .prepare(`
        INSERT INTO projects (project_id, name, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
        .run(projectId, trimmedName, userId, now, now);

      this.db
        .prepare(`
        INSERT INTO memberships (membership_id, project_id, user_id, role, created_at)
        VALUES (?, ?, ?, 'owner', ?)
      `)
        .run(membershipId, projectId, userId, now);

      this.eventBus.recordEvent(projectId, userId, "project.created", {
        name: trimmedName,
        created_by_user_id: userId,
      });

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }

    return {
      project: {
        project_id: projectId,
        name: trimmedName,
        created_by_user_id: userId,
        created_at: now,
        updated_at: now,
      },
      membership: {
        membership_id: membershipId,
        project_id: projectId,
        user_id: userId,
        role: "owner",
        created_at: now,
      },
    };
  }

  public getProject(projectId: string): Project {
    const stmt = this.db.prepare("SELECT * FROM projects WHERE project_id = ?");
    const row = stmt.get(projectId) as Project | undefined;
    if (!row) {
      throw new AppError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
    }
    return row;
  }

  public checkMembership(projectId: string, userId: string): Membership {
    const stmt = this.db.prepare("SELECT * FROM memberships WHERE project_id = ? AND user_id = ?");
    const row = stmt.get(projectId, userId) as Membership | undefined;
    if (!row) {
      throw new AppError("FORBIDDEN", `User ${userId} is not a member of project ${projectId}`);
    }
    return row;
  }
}
