import {
  AppError,
  LocalAccessInputSchema,
  LocalIssuedAccessSchema,
  LocalSnapshotSchema,
  LocalUserInputSchema,
  UuidSchema,
} from "@agents-hub/shared";
import type { AdministrationRepository } from "../ports/administration.js";
import type { UnitOfWork } from "../ports/persistence.js";
import type { AuditService } from "./audit-service.js";

export class AdministrationService {
  constructor(
    private repository: AdministrationRepository,
    private unit: UnitOfWork,
    private audit: AuditService,
  ) {}

  snapshot() {
    return LocalSnapshotSchema.parse({
      users: this.repository.users(),
      accesses: this.repository.accesses(),
      projects: this.repository.projects(),
    });
  }

  createUser(input: unknown, requestId: string) {
    const parsed = LocalUserInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        "Usa 1–80 letras, números, punto, guion o guion bajo y una duración válida.",
      );
    return this.unit.transaction(() => {
      if (this.repository.usernameExists(parsed.data.username))
        throw new AppError(
          "STATE_CONFLICT",
          "Esta persona ya existe. Selecciónala para emitir otro acceso.",
        );
      const user = {
        user_id: crypto.randomUUID(),
        username: parsed.data.username,
        created_at: new Date().toISOString(),
      };
      this.repository.insertUser(user);
      this.audit.logAction("local-admin", "user.provision", user.user_id, "success", requestId);
      const access = this.issueAccess(
        user.user_id,
        { ttl_seconds: parsed.data.ttl_seconds },
        requestId,
      );
      return { user, access };
    });
  }

  issueAccess(userId: string, input: unknown, requestId: string) {
    const parsed = LocalAccessInputSchema.safeParse(input);
    if (!UuidSchema.safeParse(userId).success || !parsed.success)
      throw new AppError("INVALID_INPUT", "Persona, proyecto o duración de acceso inválidos.");
    return this.unit.transaction(() => {
      if (!this.repository.findUser(userId))
        throw new AppError("INVALID_INPUT", "Selecciona una persona existente.");
      const access = LocalIssuedAccessSchema.parse(
        this.repository.issueAccess(userId, parsed.data.ttl_seconds, parsed.data.project_id),
      );
      this.audit.logAction(
        "local-admin",
        "token.issue",
        access.token_id,
        "success",
        requestId,
        parsed.data.project_id,
      );
      return access;
    });
  }

  revokeAccess(tokenId: string, requestId: string) {
    if (!UuidSchema.safeParse(tokenId).success)
      throw new AppError("INVALID_INPUT", "Selecciona un acceso válido.");
    return this.unit.transaction(() => {
      if (!this.repository.revokeAccess(tokenId))
        throw new AppError("INVALID_INPUT", "Este acceso no existe.");
      this.audit.logAction("local-admin", "token.revoke", tokenId, "success", requestId);
      return { revoked: true };
    });
  }
}
