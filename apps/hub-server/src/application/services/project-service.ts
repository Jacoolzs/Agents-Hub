import { AppError, type Membership, type Project, generateId, nowUtc } from "@agents-hub/shared";
import type { DomainEvents, ProjectRepository } from "../ports/persistence.js";

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly eventBus: DomainEvents,
  ) {}

  public createProject(
    name: string,
    userId: string,
    username = "user",
  ): { project: Project; membership: Membership } {
    const trimmedName = name.trim();
    if (!trimmedName) throw new AppError("INVALID_INPUT", "Project name cannot be empty");
    const now = nowUtc();
    const project: Project = {
      project_id: generateId(),
      name: trimmedName,
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
    };
    const membership: Membership = {
      membership_id: generateId(),
      project_id: project.project_id,
      user_id: userId,
      role: "owner",
      created_at: now,
    };
    return this.eventBus.transaction(() => {
      this.repository.ensureUser(userId, `${username}-${userId.slice(0, 8)}`, now);
      this.repository.insert(project);
      this.repository.insertMembership(membership);
      this.eventBus.recordEvent(project.project_id, userId, "project.created", {
        name: trimmedName,
        created_by_user_id: userId,
      });
      return { project, membership };
    });
  }

  public getProject(projectId: string): Project {
    const project = this.repository.find(projectId);
    if (!project) throw new AppError("PROJECT_NOT_FOUND", `Project ${projectId} not found`);
    return project;
  }

  public checkMembership(projectId: string, userId: string): Membership {
    const membership = this.repository.findMembership(projectId, userId);
    if (!membership)
      throw new AppError("FORBIDDEN", `User ${userId} is not a member of project ${projectId}`);
    return membership;
  }
}
