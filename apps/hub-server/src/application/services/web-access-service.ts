import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  UuidSchema,
  WebEntryExchangeSchema,
  WebEntryInputSchema,
  WebEntrySchema,
  WebInvitationInputSchema,
  WebInvitationMetadataSchema,
  WebSessionSchema,
} from "@agents-hub/shared";
import type { DomainEvents } from "../ports/persistence.js";
import type { WebAccessRepository, WebIdentity, WebSessionAuthority } from "../ports/web-access.js";
import type { AuditService } from "./audit-service.js";

export class WebAccessService {
  constructor(
    private repository: WebAccessRepository,
    private unit: DomainEvents,
    private authority: WebSessionAuthority,
    private audit: AuditService,
    private now = Date.now,
  ) {}

  issueInvitation(input: unknown, requestId: string) {
    const parsed = WebInvitationInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        "Selecciona persona, proyecto, permisos y duración válidos.",
      );
    return this.unit.transaction(() => {
      const { person, project_id, role, ttl_seconds } = parsed.data;
      if (!this.repository.project(project_id))
        throw new AppError("INVALID_INPUT", "El proyecto no existe.");
      const userId = person.kind === "new" ? randomUUID() : person.user_id;
      if (person.kind === "new") {
        if (this.repository.usernameExists(person.username))
          throw new AppError(
            "STATE_CONFLICT",
            "Esta persona ya existe. Selecciónala explícitamente.",
          );
        this.repository.insertUser({
          user_id: userId,
          username: person.username,
          created_at: new Date(this.now()).toISOString(),
        });
        this.audit.logAction("local-admin", "user.provision", userId, "success", requestId);
      } else if (!this.repository.user(userId))
        throw new AppError("INVALID_INPUT", "La persona no existe.");
      if (this.repository.memberExists(userId, project_id))
        throw new AppError(
          "STATE_CONFLICT",
          "La persona ya pertenece al proyecto. Crea una entrada al portal sin cambiar sus permisos.",
        );
      const entry = WebEntrySchema.parse({
        entry_id: randomUUID(),
        secret: `ahb_${randomBytes(32).toString("base64url")}`,
        expires_at: new Date(this.now() + ttl_seconds * 1000).toISOString(),
      });
      this.repository.insertEntry({
        entry_id: entry.entry_id,
        secret_hash: this.hash(entry.secret),
        user_id: userId,
        project_id,
        expires_at: entry.expires_at,
        created_at: new Date(this.now()).toISOString(),
        pending_role: role,
      });
      this.audit.logAction(
        "local-admin",
        "web.invitation.issue",
        entry.entry_id,
        "success",
        requestId,
        project_id,
      );
      return entry;
    });
  }
  listInvitations() {
    return this.repository
      .invitations()
      .map((invitation) => WebInvitationMetadataSchema.parse(invitation));
  }
  revokeInvitation(entryId: string, requestId: string) {
    if (!UuidSchema.safeParse(entryId).success)
      throw new AppError("INVALID_INPUT", "Selecciona una invitación válida.");
    return this.unit.transaction(() => {
      if (!this.repository.revokeInvitation(entryId, new Date(this.now()).toISOString()))
        throw new AppError(
          "STATE_CONFLICT",
          "La invitación ya fue utilizada, revocada o no existe.",
        );
      this.audit.logAction("local-admin", "web.invitation.revoke", entryId, "success", requestId);
      return { revoked: true };
    });
  }

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
      if (entry.pending_role) {
        if (this.repository.memberExists(entry.user_id, entry.project_id))
          throw new AppError(
            "STATE_CONFLICT",
            "La persona ya pertenece al proyecto. Solicita una entrada nueva.",
          );
        this.repository.insertMembership({
          membership_id: randomUUID(),
          user_id: entry.user_id,
          project_id: entry.project_id,
          role: entry.pending_role,
          created_at: new Date(this.now()).toISOString(),
        });
        this.audit.logAction(
          entry.user_id,
          "web.invitation.accept",
          entry.entry_id,
          "success",
          requestId,
          entry.project_id,
        );
        this.unit.recordEvent(entry.project_id, entry.user_id, "membership.updated", {
          user_id: entry.user_id,
          role: entry.pending_role,
        });
      }
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
    if (entry.pending_role) {
      const user = this.repository.user(entry.user_id);
      const project = this.repository.project(entry.project_id);
      if (!user || !project)
        throw new AppError("UNAUTHENTICATED", "La persona o el proyecto ya no están disponibles.");
      if (this.repository.memberExists(entry.user_id, entry.project_id))
        throw new AppError(
          "STATE_CONFLICT",
          "La persona ya pertenece al proyecto. Solicita una entrada nueva.",
        );
      return WebSessionSchema.parse({
        user,
        project: { ...project, role: entry.pending_role },
        expires_at: entry.expires_at,
      });
    }
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
