import type { DatabaseSync } from "node:sqlite";
import type { Membership, Project } from "@agents-hub/shared";
import type { ProjectRepository } from "../../application/ports/persistence.js";

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  public ensureUser(userId: string, username: string, createdAt: string): void {
    if (!this.db.prepare("SELECT user_id FROM users WHERE user_id = ?").get(userId))
      this.db
        .prepare("INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)")
        .run(userId, username, createdAt);
  }
  public insert(project: Project): void {
    this.db
      .prepare(
        "INSERT INTO projects (project_id, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        project.project_id,
        project.name,
        project.created_by_user_id,
        project.created_at,
        project.updated_at,
      );
  }
  public insertMembership(membership: Membership): void {
    this.db
      .prepare(
        "INSERT INTO memberships (membership_id, project_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        membership.membership_id,
        membership.project_id,
        membership.user_id,
        membership.role,
        membership.created_at,
      );
  }
  public find(projectId: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId) as
      | Project
      | undefined;
  }
  public findMembership(projectId: string, userId: string): Membership | undefined {
    return this.db
      .prepare("SELECT * FROM memberships WHERE project_id = ? AND user_id = ?")
      .get(projectId, userId) as Membership | undefined;
  }
}
