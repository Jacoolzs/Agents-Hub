import type { DatabaseSync } from "node:sqlite";
import type { EnvConfig } from "@agents-hub/config";
import { AppError } from "@agents-hub/shared";
import { type AppContext, buildApp } from "../app.js";
import type { LocalRuntime } from "./control-app.js";

export interface TunnelTransport {
  url(): string | null;
  start(): Promise<string>;
  stop(): Promise<void>;
  ready?(): Promise<void>;
}

export class CompanionRuntime implements LocalRuntime {
  private hub: ReturnType<typeof buildApp> | undefined;
  private idle: AppContext;
  private constructor(
    private config: EnvConfig,
    private db: DatabaseSync,
    private tunnel: TunnelTransport,
    idle: AppContext,
  ) {
    this.idle = idle;
  }

  static async create(config: EnvConfig, db: DatabaseSync, tunnel: TunnelTransport) {
    // Compose the existing services without leaving HTTP or maintenance running while stopped.
    const idle = buildApp(config, db);
    await idle.ready();
    await idle.close();
    return new CompanionRuntime(config, db, tunnel, idle.ctx);
  }
  context() {
    return this.hub?.ctx ?? this.idle;
  }
  status() {
    return {
      hub: this.hub ? ("running" as const) : ("stopped" as const),
      sharing: this.tunnel.url() ? ("running" as const) : ("stopped" as const),
      portal_url: this.hub ? (this.tunnel.url() ?? `http://127.0.0.1:${this.config.PORT}`) : null,
    };
  }
  async start() {
    if (this.hub) return;
    const local = `http://127.0.0.1:${this.config.PORT}`;
    const hub = buildApp(
      {
        ...this.config,
        HOST: "127.0.0.1",
        CORS_ORIGINS: [local, this.tunnel.url()].filter(Boolean).join(","),
      },
      this.db,
    );
    try {
      await hub.listen({ host: "127.0.0.1", port: this.config.PORT });
      this.hub = hub;
    } catch {
      await hub.close();
      throw new AppError(
        "STATE_CONFLICT",
        "No se pudo iniciar el Hub. Su puerto puede estar ocupado por otra instancia; ciérrala o elige otro puerto.",
      );
    }
  }
  private async stopHub() {
    const hub = this.hub;
    if (!hub) return;
    await hub.close();
    this.hub = undefined;
    this.idle = hub.ctx;
  }
  async stop() {
    await this.tunnel.stop();
    await this.stopHub();
  }
  async share() {
    if (this.tunnel.url() && this.hub) return;
    const wasRunning = !!this.hub;
    let recomposed = false;
    try {
      await this.tunnel.start();
      // Recompose the transport with the exact public origin; persistent data/checkpoints remain.
      await this.stopHub();
      recomposed = true;
      await this.start();
      await this.tunnel.ready?.();
    } catch (error) {
      await this.tunnel.stop();
      if (recomposed) await this.stopHub();
      if (wasRunning && !this.hub) await this.start();
      throw error;
    }
  }
  async stopSharing() {
    await this.tunnel.stop();
  }
}
