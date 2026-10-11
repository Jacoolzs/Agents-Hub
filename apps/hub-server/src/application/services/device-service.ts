import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AppError,
  DeviceApproveInputSchema,
  DeviceCredentialSchema,
  DeviceExchangeInputSchema,
  DeviceMetadataSchema,
  DevicePreviewInputSchema,
  DevicePreviewSchema,
  DeviceRequestInputSchema,
  DeviceRequestSchema,
  UuidSchema,
  type WebSession,
} from "@agents-hub/shared";
import type { DeviceAuthority, DeviceRepository, DeviceRequestRecord } from "../ports/device.js";
import type { DomainEvents } from "../ports/persistence.js";
import type { WebIdentity } from "../ports/web-access.js";
import type { AuditService } from "./audit-service.js";
import type { WebAccessService } from "./web-access-service.js";

const unavailable = () =>
  new AppError("UNAUTHENTICATED", "Vinculación pendiente, vencida o no disponible.");
const reviewAgain = () =>
  new AppError(
    "STATE_CONFLICT",
    "La revisión venció o cambió. Revisa el dispositivo otra vez antes de confirmar.",
  );
export class DeviceService {
  private readonly approvalKey = randomBytes(32);
  constructor(
    private repository: DeviceRepository,
    private unit: DomainEvents,
    private authority: DeviceAuthority,
    private web: WebAccessService,
    private audit: AuditService,
    private now = Date.now,
  ) {}

  request(input: unknown) {
    const parsed = DeviceRequestInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "INVALID_INPUT",
        "Usa una etiqueta de dispositivo válida, sin credenciales.",
      );
    const result = DeviceRequestSchema.parse({
      request_id: randomUUID(),
      device_secret: `ahd_${randomBytes(32).toString("base64url")}`,
      expires_at: new Date(this.now() + 300000).toISOString(),
    });
    this.repository.insert({
      request_id: result.request_id,
      label: parsed.data.label,
      secret_hash: this.hash(result.device_secret),
      expires_at: result.expires_at,
      created_at: new Date(this.now()).toISOString(),
    });
    return result;
  }
  preview(identity: WebIdentity, input: unknown) {
    const parsed = DevicePreviewInputSchema.safeParse(input);
    if (!parsed.success) throw unavailable();
    if (!this.authority.humanSessionActive(identity, new Date(this.now()).toISOString()))
      throw unavailable();
    const record = this.repository.pending(
      parsed.data.request_id,
      new Date(this.now()).toISOString(),
    );
    if (!record) throw unavailable();
    const profile = this.web.profile(identity);
    const expiresAt = new Date(
      Math.min(this.now() + 120000, Date.parse(record.expires_at), Date.parse(profile.expires_at)),
    ).toISOString();
    if (Date.parse(expiresAt) <= this.now()) throw unavailable();
    return DevicePreviewSchema.parse({
      ...record,
      profile,
      approval: { proof: this.proof(identity, record, profile, expiresAt), expires_at: expiresAt },
    });
  }
  approve(identity: WebIdentity, input: unknown, requestId: string) {
    const parsed = DeviceApproveInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("INVALID_INPUT", "Confirma explícitamente la solicitud de dispositivo.");
    return this.unit.transaction(() => {
      const now = this.now();
      if (!this.authority.humanSessionActive(identity, new Date(now).toISOString()))
        throw unavailable();
      const profile = this.web.profile(identity);
      const record = this.repository.pending(parsed.data.request_id, new Date(now).toISOString());
      if (!record) throw unavailable();
      const approval = parsed.data.approval;
      if (
        Date.parse(approval.expires_at) <= now ||
        Date.parse(profile.expires_at) <= now ||
        !timingSafeEqual(
          Buffer.from(approval.proof),
          Buffer.from(this.proof(identity, record, profile, approval.expires_at)),
        )
      )
        throw reviewAgain();
      if (
        !this.repository.approve(
          parsed.data.request_id,
          identity.userId,
          profile.project.project_id,
          new Date(now).toISOString(),
        )
      )
        throw unavailable();
      this.audit.logAction(
        identity.userId,
        "device.approve",
        parsed.data.request_id,
        "success",
        requestId,
        profile.project.project_id,
      );
      return { approved: true };
    });
  }
  exchange(input: unknown, requestId: string) {
    const parsed = DeviceExchangeInputSchema.safeParse(input);
    if (!parsed.success) throw unavailable();
    return this.unit.transaction(() => {
      const record = this.repository.consume(
        this.hash(parsed.data.device_secret),
        new Date(this.now()).toISOString(),
      );
      if (!record) throw unavailable();
      // Do not consume approved requests after membership was removed.
      try {
        this.authority.checkProjectPermission(record.user_id, record.project_id);
      } catch (error) {
        if (error instanceof AppError && error.code === "FORBIDDEN") throw unavailable();
        throw error;
      }
      const credential = DeviceCredentialSchema.parse(
        this.authority.issue(record.user_id, record.project_id),
      );
      this.repository.attach(record.request_id, credential.token_id);
      this.audit.logAction(
        record.user_id,
        "device.issue",
        credential.token_id,
        "success",
        requestId,
        record.project_id,
      );
      return credential;
    });
  }
  list(identity: WebIdentity) {
    const profile = this.web.profile(identity);
    return this.repository
      .list(identity.userId, profile.project.project_id)
      .map((record) => DeviceMetadataSchema.parse(record));
  }
  revoke(identity: WebIdentity, tokenId: string, requestId: string) {
    if (!UuidSchema.safeParse(tokenId).success) throw unavailable();
    return this.unit.transaction(() => {
      const profile = this.web.profile(identity);
      if (
        !this.repository.revoke(
          tokenId,
          identity.userId,
          profile.project.project_id,
          new Date(this.now()).toISOString(),
        )
      )
        throw unavailable();
      this.audit.logAction(
        identity.userId,
        "device.revoke",
        tokenId,
        "success",
        requestId,
        profile.project.project_id,
      );
      return { revoked: true };
    });
  }
  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  private proof(
    identity: WebIdentity,
    record: DeviceRequestRecord,
    profile: WebSession,
    expiresAt: string,
  ) {
    const context = [
      1,
      identity.tokenId,
      profile.user.user_id,
      profile.user.username,
      profile.project.project_id,
      profile.project.name,
      profile.project.role,
      profile.expires_at,
      record.request_id,
      record.label,
      record.expires_at,
      expiresAt,
    ];
    return `ahp_${createHmac("sha256", this.approvalKey).update(JSON.stringify(context)).digest("base64url")}`;
  }
}
