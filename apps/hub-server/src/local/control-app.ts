import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  AppError,
  LocalBootstrapSchema,
  LocalInstallInputSchema,
  LocalInstallationResultSchema,
  LocalInstallationSchema,
  LocalProjectInputSchema,
  LocalShutdownInputSchema,
  UuidSchema,
} from "@agents-hub/shared";
import fastify from "fastify";
import type { AppContext } from "../app.js";
import { AdministrationService } from "../application/services/administration-service.js";
import { LocalWorkspaceService } from "../application/services/local-workspace-service.js";
import { registerStaticRoutes } from "../http/routes/static-routes.js";
import { SqliteAdministrationRepository } from "../infrastructure/repositories/sqlite-administration-repository.js";
import type { ConnectionAssistant } from "./connection-assistant.js";

export interface LocalRuntime {
  context(): AppContext;
  status(): {
    hub: "stopped" | "running";
    sharing: "stopped" | "running";
    portal_url: string | null;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
  share(): Promise<void>;
  stopSharing(): Promise<void>;
}
export interface LocalInstallation {
  describe(): Promise<unknown>;
  install(desktop: boolean): Promise<unknown>;
}

export function buildLocalControl(
  runtime: LocalRuntime,
  origin: string,
  staticDirectory?: string,
  now = Date.now,
  closeCompanion?: () => void,
  installation?: LocalInstallation,
  connections?: Pick<
    ConnectionAssistant,
    "start" | "finish" | "list" | "diagnose" | "importPreview" | "importApply"
  >,
) {
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.protocol !== "http:" ||
    parsedOrigin.hostname !== "127.0.0.1" ||
    parsedOrigin.origin !== origin
  )
    throw new Error("Local control requires an exact loopback origin");
  const app = fastify({ logger: false, bodyLimit: 8192 });
  let bootstrap: string | undefined = randomBytes(32).toString("base64url");
  let bootstrapUntil = now() + 300000;
  let session: string | undefined;
  let sessionUntil = 0;
  const bootstrapUrl = `${origin}/?local-control=1#local-control=${bootstrap}`;
  let changingRuntime = false;
  let closing = false;
  const equal = (left: string | undefined, right: string | undefined) =>
    !!left &&
    !!right &&
    /^[A-Za-z0-9_-]{43}$/.test(left) &&
    /^[A-Za-z0-9_-]{43}$/.test(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right));
  const administrative = () => {
    const ctx = runtime.context();
    return new AdministrationService(
      new SqliteAdministrationRepository(ctx.db),
      ctx.eventBus,
      ctx.auditService,
    );
  };

  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (
      req.headers.host !== parsedOrigin.host ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.ip)
    )
      throw new AppError("FORBIDDEN", "El panel sólo admite acceso desde este PC.");
    const route = req.routeOptions.url;
    if (!route?.startsWith("/local-api/")) return;
    if (closing)
      throw new AppError(
        "STATE_CONFLICT",
        "Agents-Hub se está cerrando. Reabre el compañero después de que termine.",
      );
    const requestOrigin = req.headers.origin;
    if (
      (requestOrigin && requestOrigin !== origin) ||
      (req.method !== "GET" && requestOrigin !== origin)
    )
      throw new AppError("FORBIDDEN", "Origen de administración no autorizado.");
    if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
      throw new AppError("FORBIDDEN", "Abre el panel desde el compañero local.");
    if (route === "/local-api/bootstrap" && req.method === "POST") return;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("ah_local="))
      ?.slice(9);
    if (now() >= sessionUntil || !equal(cookie, session))
      throw new AppError(
        "UNAUTHENTICATED",
        "La sesión local terminó. Reabre Agents-Hub para administrar.",
      );
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      const statuses: Record<string, number> = {
        FORBIDDEN: 403,
        UNAUTHENTICATED: 401,
        INVALID_INPUT: 422,
        STATE_CONFLICT: 409,
      };
      const status = statuses[error.code];
      return reply
        .code(status ?? 400)
        .send({ error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "No se completó la operación. Comprueba el estado y vuelve a intentarlo.",
      },
    });
  });
  app.post("/local-api/bootstrap", async (req, reply) => {
    const body = LocalBootstrapSchema.safeParse(req.body);
    if (!body.success || now() >= bootstrapUntil || !equal(body.data.secret, bootstrap))
      throw new AppError(
        "UNAUTHENTICATED",
        "El enlace local venció o ya fue usado. Reabre Agents-Hub.",
      );
    bootstrap = undefined;
    session = randomBytes(32).toString("base64url");
    sessionUntil = now() + 28800000;
    reply.header(
      "set-cookie",
      `ah_local=${session}; HttpOnly; SameSite=Strict; Path=/local-api/; Max-Age=28800`,
    );
    return { connected: true };
  });
  app.post("/local-api/logout", async (_req, reply) => {
    session = undefined;
    sessionUntil = 0;
    reply.header("set-cookie", "ah_local=; HttpOnly; SameSite=Strict; Path=/local-api/; Max-Age=0");
    return { connected: false };
  });
  app.post(
    "/local-api/companion/shutdown",
    {
      onResponse: async (_req, reply) => {
        // Never close the HTTP listener before the acceptance response has been sent.
        if (reply.statusCode === 202) closeCompanion?.();
      },
    },
    async (req, reply) => {
      if (!LocalShutdownInputSchema.safeParse(req.body).success)
        throw new AppError("INVALID_INPUT", "Confirma el cierre de Agents-Hub.");
      if (!closeCompanion || changingRuntime)
        throw new AppError(
          "STATE_CONFLICT",
          "No se puede cerrar ahora. Espera a que termine la operación y vuelve a intentarlo.",
        );
      closing = true;
      bootstrap = undefined;
      session = undefined;
      sessionUntil = 0;
      reply.header(
        "set-cookie",
        "ah_local=; HttpOnly; SameSite=Strict; Path=/local-api/; Max-Age=0",
      );
      return reply.code(202).send({ closing: true });
    },
  );
  app.get("/local-api/snapshot", async () => ({
    ...administrative().snapshot(),
    runtime: runtime.status(),
  }));
  app.get("/local-api/connections", async () => (connections ? await connections.list() : []));
  for (const [route, operation] of [
    ["start", "start"],
    ["finish", "finish"],
    ["diagnose", "diagnose"],
    ["import/preview", "importPreview"],
    ["import/apply", "importApply"],
  ] as const)
    app.post(`/local-api/connections/${route}`, async (req) => {
      if (!connections || changingRuntime)
        throw new AppError("STATE_CONFLICT", "Espera a que termine la operación del compañero.");
      changingRuntime = true;
      try {
        return await connections[operation](req.body);
      } finally {
        changingRuntime = false;
      }
    });
  app.get("/local-api/installation", async () =>
    LocalInstallationSchema.parse(
      installation
        ? await installation.describe()
        : { state: "unavailable", destination: null, data: null },
    ),
  );
  app.post("/local-api/installation", async (req) => {
    const body = LocalInstallInputSchema.safeParse(req.body);
    if (!body.success)
      throw new AppError(
        "INVALID_INPUT",
        "Confirma la instalación y los accesos que quieres crear.",
      );
    if (!installation || changingRuntime)
      throw new AppError(
        "STATE_CONFLICT",
        "Instala desde un paquete completo y espera a que termine cualquier operación en curso.",
      );
    changingRuntime = true;
    try {
      return LocalInstallationResultSchema.parse(await installation.install(body.data.desktop));
    } catch {
      throw new AppError(
        "STATE_CONFLICT",
        "No se completó la instalación o los accesos. Se conservan los datos y las copias existentes. Revisa permisos, carpetas incompletas y accesos con el mismo nombre; puedes reintentar sin reemplazarlos.",
      );
    } finally {
      changingRuntime = false;
    }
  });
  app.post("/local-api/users", async (req) => administrative().createUser(req.body, req.id));
  app.post("/local-api/workspaces", async (req) => {
    const ctx = runtime.context();
    return new LocalWorkspaceService(
      new SqliteAdministrationRepository(ctx.db),
      ctx.eventBus,
      ctx.projectService,
      ctx.auditService,
    ).create(req.body, req.id);
  });
  app.post("/local-api/web-invitations", async (req) =>
    runtime.context().webAccessService.issueInvitation(req.body, req.id),
  );
  app.get("/local-api/web-invitations", async () =>
    runtime.context().webAccessService.listInvitations(),
  );
  app.delete<{ Params: { entryId: string } }>("/local-api/web-invitations/:entryId", async (req) =>
    runtime.context().webAccessService.revokeInvitation(req.params.entryId, req.id),
  );
  app.post<{ Params: { userId: string } }>("/local-api/users/:userId/accesses", async (req) =>
    administrative().issueAccess(req.params.userId, req.body, req.id),
  );
  app.post<{ Params: { userId: string } }>("/local-api/users/:userId/web-entry", async (req) =>
    runtime.context().webAccessService.issueEntry(req.params.userId, req.body, req.id),
  );
  app.post<{ Params: { userId: string } }>(
    "/local-api/users/:userId/reset-web-account",
    async (req) => {
      const ctx = runtime.context();
      const result = ctx.webAccountService.reset(req.params.userId, req.id);
      ctx.wsHub.revalidate();
      return result;
    },
  );
  app.delete<{ Params: { tokenId: string } }>("/local-api/accesses/:tokenId", async (req) => {
    const result = administrative().revokeAccess(req.params.tokenId, req.id);
    runtime.context().wsHub.revalidate();
    return result;
  });
  app.post("/local-api/projects", async (req) => {
    const body = LocalProjectInputSchema.safeParse(req.body);
    if (!body.success)
      throw new AppError("INVALID_INPUT", "Escribe un nombre y selecciona al dueño del proyecto.");
    const ctx = runtime.context();
    const user = new SqliteAdministrationRepository(ctx.db).findUser(body.data.user_id);
    if (!user) throw new AppError("INVALID_INPUT", "Selecciona una persona existente.");
    return ctx.eventBus.transaction(() => {
      const result = ctx.projectService.createProject(body.data.name, user.user_id, user.username);
      ctx.auditService.logAction(
        "local-admin",
        "project.create",
        result.project.project_id,
        "success",
        req.id,
        result.project.project_id,
      );
      return result.project;
    });
  });
  app.post<{ Params: { projectId: string } }>(
    "/local-api/projects/:projectId/invitations",
    async (req) => {
      if (!UuidSchema.safeParse(req.params.projectId).success)
        throw new AppError("INVALID_INPUT", "Selecciona un proyecto válido.");
      const ctx = runtime.context();
      // The local operator acts through the current owner, not through historical creator identity.
      const owner = ctx.db
        .prepare("SELECT user_id FROM memberships WHERE project_id = ? AND role = 'owner'")
        .get(req.params.projectId) as { user_id: string } | undefined;
      if (!owner) throw new AppError("INVALID_INPUT", "El proyecto no tiene un dueño disponible.");
      return ctx.membershipService.createInvitation(
        owner.user_id,
        req.params.projectId,
        req.body,
        req.id,
      );
    },
  );
  for (const operation of ["start", "stop", "share", "stop-sharing"] as const)
    app.post(`/local-api/runtime/${operation}`, async () => {
      if (changingRuntime)
        throw new AppError(
          "STATE_CONFLICT",
          "Hay un cambio de arranque en curso. Espera a que termine.",
        );
      changingRuntime = true;
      try {
        if (operation === "start") await runtime.start();
        if (operation === "stop") await runtime.stop();
        if (operation === "share") await runtime.share();
        if (operation === "stop-sharing") await runtime.stopSharing();
        return runtime.status();
      } finally {
        changingRuntime = false;
      }
    });
  if (staticDirectory) registerStaticRoutes(app, staticDirectory);
  const issueBootstrap = () => {
    if (closing) throw new Error("Companion is closing");
    bootstrap = randomBytes(32).toString("base64url");
    bootstrapUntil = now() + 300000;
    return `${origin}/?local-control=1#local-control=${bootstrap}`;
  };
  return { app, bootstrapUrl, issueBootstrap };
}
