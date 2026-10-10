import {
  AppError,
  UuidSchema,
  WebLoginInputSchema,
  WebPasswordInputSchema,
} from "@agents-hub/shared";
import type { DomainEvents } from "../ports/persistence.js";
import type { WebIdentity, WebSessionAuthority } from "../ports/web-access.js";
import type { WebAccountRepository } from "../ports/web-account.js";
import type { AuditService } from "./audit-service.js";
import type { WebAccessService } from "./web-access-service.js";

export interface PasswordCodec {
  salt(): string;
  derive(password: string, salt: string): Promise<string>;
  equal(actual: string, expected: string): boolean;
}
const invalid = () =>
  new AppError("UNAUTHENTICATED", "Usuario o contraseña incorrectos, o acceso no disponible.");
export class WebAccountService {
  constructor(
    private repository: WebAccountRepository,
    private unit: DomainEvents,
    private authority: WebSessionAuthority,
    private web: WebAccessService,
    private audit: AuditService,
    private passwords: PasswordCodec,
    private now = Date.now,
  ) {}
  registered(userId: string) {
    return !!this.repository.credential(userId);
  }
  async enroll(identity: WebIdentity, input: unknown, requestId: string) {
    const parsed = WebPasswordInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("INVALID_INPUT", "Usa una contraseña de 15 a 128 caracteres.");
    if (this.registered(identity.userId))
      throw new AppError(
        "STATE_CONFLICT",
        "Esta cuenta ya tiene contraseña. Si la olvidaste, pide ayuda al anfitrión.",
      );
    const salt = this.passwords.salt();
    const hash = await this.passwords.derive(parsed.data.password, salt);
    return this.unit.transaction(() => {
      if (!this.repository.active(identity, new Date(this.now()).toISOString())) throw invalid();
      this.authority.checkProjectPermission(identity.userId, identity.projectId ?? "");
      if (this.registered(identity.userId))
        throw new AppError("STATE_CONFLICT", "Esta cuenta ya tiene contraseña.");
      this.repository.insert(
        { user_id: identity.userId, salt, password_hash: hash },
        new Date(this.now()).toISOString(),
      );
      this.audit.logAction(
        identity.userId,
        "web.account.create",
        identity.userId,
        "success",
        requestId,
      );
      return { registered: true };
    });
  }
  async login(input: unknown, requestId: string) {
    const parsed = WebLoginInputSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const record = this.repository.byUsername(parsed.data.username);
    // Missing accounts incur the same expensive derivation; no public identity lookup.
    const actual = await this.passwords.derive(
      parsed.data.password,
      record?.salt ?? "0".repeat(32),
    );
    if (!record || !this.passwords.equal(actual, record.password_hash)) throw invalid();
    return this.unit.transaction(() => {
      const current = this.repository.credential(record.user_id);
      if (
        !current ||
        current.password_hash !== record.password_hash ||
        current.salt !== record.salt
      )
        throw invalid();
      const projects = this.repository.projects(record.user_id);
      const projectId =
        parsed.data.project_id ?? (projects.length === 1 ? projects[0]?.project_id : undefined);
      if (!projects.length) throw invalid();
      if (!projectId) return { projects };
      if (!projects.some((p) => p.project_id === projectId)) throw invalid();
      const result = this.authority.issue(record.user_id, projectId);
      const profile = this.web.profile(result.identity);
      this.audit.logAction(
        record.user_id,
        "web.account.login",
        result.identity.tokenId,
        "success",
        requestId,
        projectId,
      );
      return { secret: result.secret, profile };
    });
  }
  reset(userId: string, requestId: string) {
    if (!UuidSchema.safeParse(userId).success)
      throw new AppError("INVALID_INPUT", "Selecciona una persona válida.");
    return this.unit.transaction(() => {
      if (!this.repository.reset(userId, new Date(this.now()).toISOString()))
        throw new AppError("INVALID_INPUT", "La persona no existe.");
      this.audit.logAction("local-admin", "web.account.reset", userId, "success", requestId);
      return { reset: true };
    });
  }
}
