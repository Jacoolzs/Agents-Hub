import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  UuidSchema,
  WebEntryExchangeSchema,
  WebEntryInputSchema,
  WebEntrySchema,
  WebSessionSchema,
} from "@agents-hub/shared";
import type { UnitOfWork } from "../ports/persistence.js";
import type { WebAccessRepository, WebIdentity, WebSessionAuthority } from "../ports/web-access.js";
import type { AuditService } from "./audit-service.js";

export class WebAccessService {
  constructor(
    private repository: WebAccessRepository,
    private unit: UnitOfWork,
    private authority: WebSessionAuthority,
    private audit: AuditService,
    private now = Date.now,
  ) {}

  issueEntry(userId: string, input: unknown, requestId: string) {
    const parsed = WebEntryInputSchema.safeParse(input);
    if (!UuidSchema.safeParse(userId).success || !parsed.success)
      throw new AppError("INVALID_INPUT", "Selecciona una persona y su proyecto.");
    return this.unit.transaction(() => {
      if (!this.repository.user(userId))
        throw new AppError("INVALID_INPUT", "La persona no existe.");
      this.authority.checkProjectPermission(userId, parsed.data.project_id);
      const entry = WebEntrySchema.parse({
        entry_id: randomUUID(),
        secret: `ahb_${randomBytes(32).toString("base64url")}`,
        expires_at: new Date(this.now() + 300000).toISOString(),
      });
      this.repository.insertEntry({
        entry_id: entry.entry_id,
        secret_hash: this.hash(entry.secret),
        user_id: userId,
        project_id: parsed.data.project_id,
        expires_at: entry.expires_at,
        created_at: new Date(this.now()).toISOString(),
      });
      this.audit.logAction(
        "local-admin",
        "web.entry.issue",
        entry.entry_id,
        "success",
        requestId,
        parsed.data.project_id,
      );
      return entry;
    });
  }
  exchange(input: unknown, requestId: string) {
    const parsed = WebEntryExchangeSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("UNAUTHENTICATED", "La entrada venció, fue utilizada o no es válida.");
    return this.unit.transaction(() => {
      const entry = this.repository.consumeEntry(
        this.hash(parsed.data.secret),
        new Date(this.now()).toISOString(),
      );
      if (!entry)
        throw new AppError("UNAUTHENTICATED", "La entrada venció, fue utilizada o no es válida.");
      this.authority.checkProjectPermission(entry.user_id, entry.project_id);
      const issued = this.authority.issue(entry.user_id, entry.project_id);
      const profile = this.profile(issued.identity);
      this.audit.logAction(
        entry.user_id,
        "web.session.start",
        issued.identity.tokenId,
        "success",
        requestId,
        entry.project_id,
      );
      return { secret: issued.secret, profile };
    });
  }
  preview(input: unknown) {
    const parsed = WebEntryExchangeSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("UNAUTHENTICATED", "La entrada venció, fue utilizada o no es válida.");
    const entry = this.repository.findEntry(
      this.hash(parsed.data.secret),
      new Date(this.now()).toISOString(),
    );
    if (!entry)
      throw new AppError("UNAUTHENTICATED", "La entrada venció, fue utilizada o no es válida.");
    return this.profile({
      userId: entry.user_id,
      projectId: entry.project_id,
      expiresAt: entry.expires_at,
      tokenId: "preview",
    });
  }
  profile(identity: WebIdentity) {
    if (!identity.projectId) throw new AppError("UNAUTHENTICATED", "Sesión humana inválida.");
    const user = this.repository.user(identity.userId);
    const project = this.repository.project(identity.projectId);
    if (!user || !project)
      throw new AppError("UNAUTHENTICATED", "La cuenta o el proyecto ya no están disponibles.");
    const role = this.authority.checkProjectPermission(identity.userId, identity.projectId);
    return WebSessionSchema.parse({
      user,
      project: { ...project, role },
      expires_at: identity.expiresAt,
    });
  }
  logout(identity: WebIdentity, requestId: string) {
    this.unit.transaction(() => {
      this.authority.revoke(identity.tokenId, identity.userId);
      this.audit.logAction(
        identity.userId,
        "web.session.end",
        identity.tokenId,
        "success",
        requestId,
        identity.projectId,
      );
    });
  }
  private hash(secret: string) {
    return createHash("sha256").update(secret).digest("hex");
  }
}
