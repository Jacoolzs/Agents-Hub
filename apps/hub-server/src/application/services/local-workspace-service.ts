import {
  AppError,
  type LocalUser,
  LocalWorkspaceInputSchema,
  LocalWorkspaceSchema,
} from "@agents-hub/shared";
import type { AdministrationRepository } from "../ports/administration.js";
import type { UnitOfWork } from "../ports/persistence.js";
import type { AuditService } from "./audit-service.js";
import type { ProjectService } from "./project-service.js";

/** Local operator only. Does not issue agent credentials or start public listeners. */
export class LocalWorkspaceService {
  constructor(
    private repository: AdministrationRepository,
    private unit: UnitOfWork,
    private projects: ProjectService,
    private audit: AuditService,
  ) {}
  create(input: unknown, requestId: string) {
    const parsed = LocalWorkspaceInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("INVALID_INPUT", "Escribe un nombre válido y el nombre del proyecto.");
    return this.unit.transaction(() => {
      const { person, name } = parsed.data;
      let user: LocalUser;
      if (person.kind === "new") {
        if (this.repository.usernameExists(person.username))
          throw new AppError(
            "STATE_CONFLICT",
            "Esta persona ya existe. Selecciónala explícitamente.",
          );
        user = {
          user_id: crypto.randomUUID(),
          username: person.username,
          created_at: new Date().toISOString(),
        };
        this.repository.insertUser(user);
        this.audit.logAction("local-admin", "user.provision", user.user_id, "success", requestId);
      } else {
        const existing = this.repository.findUser(person.user_id);
        if (!existing) throw new AppError("INVALID_INPUT", "La persona seleccionada ya no existe.");
        user = existing;
      }
      const { project } = this.projects.createProject(name, user.user_id, user.username);
      this.audit.logAction(
        "local-admin",
        "workspace.create",
        project.project_id,
        "success",
        requestId,
        project.project_id,
      );
      return LocalWorkspaceSchema.parse({ user, project });
    });
  }
}
