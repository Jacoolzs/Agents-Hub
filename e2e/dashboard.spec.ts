import { expect, test } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { type AppContext, buildApp } from "../apps/hub-server/src/app.js";

let server: FastifyInstance & { ctx: AppContext };
const PORT = 8787;
const HUB_URL = `http://127.0.0.1:${PORT}`;
let authToken = "";
let testProjectId = "";
const testUserId = crypto.randomUUID();

test.beforeAll(async () => {
  server = buildApp({
    HOST: "127.0.0.1",
    PORT,
    DATABASE_URL: ":memory:",
    CORS_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
    NODE_ENV: "production",
  });

  await server.listen({ host: "127.0.0.1", port: PORT });

  // Create auth token
  authToken = server.ctx.authService.createToken(testUserId, "agents-hub");

  // Create test project
  const result = server.ctx.projectService.createProject("E2E Test Space", testUserId, "tester");
  testProjectId = result.project.project_id;
});

test.afterAll(async () => {
  if (server) {
    await server.close();
    server.ctx.db.close();
  }
});

test("presencia separa contacto, reporte histórico y espera con recuperación de una lectura fallida", async ({
  page,
}, testInfo) => {
  const project = server.ctx.projectService.createProject("Señales del equipo", testUserId).project
    .project_id;
  for (const name of ["waiting-agent", "quiet-agent", "offline-agent"])
    server.ctx.sessionService.joinProject(project, name, testUserId);
  const report = server.ctx.statusService.reportStatus(project, "waiting-agent", {
    objective: "Esperar revisión del contrato",
    progress: "blocked",
    blocked_by: "Revisión humana pendiente",
  });
  server.ctx.db
    .prepare("UPDATE status_reports SET reported_at = ? WHERE status_id = ?")
    .run("2026-10-07T08:00:00.000Z", report.status_id);
  server.ctx.db
    .prepare(
      "UPDATE agent_sessions SET last_seen_at = ? WHERE project_id = ? AND agent_id = 'quiet-agent'",
    )
    .run(new Date(Date.now() - 90_000).toISOString(), project);
  server.ctx.sessionService.disconnect(project, "offline-agent");
  await page.goto("/");
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", project);
  await page.fill("#agent-id", "presence-dashboard");
  await page.click("button[type=submit]");
  await expect(page.getByText("Conexión de esta vista", { exact: true })).toBeVisible();
  await page.getByTestId("tab-agents").click();
  const waiting = page.getByRole("article", { name: "Estado de waiting-agent", exact: true });
  const quiet = page.getByRole("article", { name: "Estado de quiet-agent", exact: true });
  const offline = page.getByRole("article", { name: "Estado de offline-agent", exact: true });
  await expect(waiting.getByText("Contacto reciente", { exact: true })).toBeVisible();
  await expect(waiting.getByText("Bloqueado", { exact: true })).toBeVisible();
  await expect(waiting.getByText("Bloqueo / espera declarada:", { exact: true })).toBeVisible();
  await expect(waiting.locator("time[datetime='2026-10-07T08:00:00.000Z']")).toBeVisible();
  await expect(quiet.getByText("Sin contacto reciente", { exact: true })).toBeVisible();
  await expect(
    quiet.getByText("Sin reporte de actividad. No se sabe si está trabajando o esperando.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(offline.getByText("Desconectado", { exact: true })).toBeVisible();
  server.ctx.sessionService.heartbeat(project, "quiet-agent");
  server.ctx.sessionService.joinProject(project, "offline-agent", testUserId);
  server.ctx.sessionService.heartbeat(project, "waiting-agent");
  await page.getByRole("button", { name: "Actualizar equipo", exact: true }).click();
  await expect(quiet.getByText("Contacto reciente", { exact: true })).toBeVisible();
  await expect(offline.getByText("Contacto reciente", { exact: true })).toBeVisible();
  await expect(waiting.locator("time[datetime='2026-10-07T08:00:00.000Z']")).toBeVisible();
  const teamRoute = /\/v1\/projects\/[^/]+\/team-status$/;
  await page.route(teamRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "No se puede actualizar el equipo" },
      }),
    }),
  );
  await page.getByRole("button", { name: "Actualizar equipo", exact: true }).click();
  await expect(
    page.getByText("No se pudo actualizar. Mostrando la última lectura disponible.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(waiting).toBeVisible();
  await page.unroute(teamRoute);
  await page.getByRole("button", { name: "Actualizar equipo", exact: true }).click();
  await expect(page.getByText("No se pudo actualizar.", { exact: false })).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .locator("#section-agents")
    .screenshot({ path: testInfo.outputPath("presence-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("presence-desktop.png"), fullPage: true });
});

test("respuestas privadas conservan audiencia, seleccionan agentes desconectados y cargan el original", async ({
  page,
}, testInfo) => {
  const project = server.ctx.projectService.createProject("Conversaciones privadas", testUserId)
    .project.project_id;
  for (const agent of ["writer", "reply-dashboard", "offline-bob", "outsider"])
    server.ctx.sessionService.joinProject(project, agent, testUserId);
  server.ctx.sessionService.disconnect(project, "offline-bob");
  server.ctx.sessionService.disconnect(project, "reply-dashboard");
  const root = server.ctx.messageService.sendMessage(project, "writer", {
    channel: "contratos",
    body: "Contrato original antes de la página actual",
    recipient_agent_ids: ["reply-dashboard", "offline-bob"],
  });
  server.ctx.db
    .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
    .run("2026-10-08T01:00:00.000Z", root.message_id);
  for (let index = 0; index < 51; index++) {
    const noise = server.ctx.messageService.sendMessage(project, "writer", {
      body: `Otro tema ${index}`,
    });
    server.ctx.db
      .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
      .run(`2026-10-08T02:00:${String(index).padStart(2, "0")}.000Z`, noise.message_id);
  }
  const priorReply = server.ctx.messageService.sendMessage(project, "writer", {
    channel: "contratos",
    body: "Seguimos con este contrato privado",
    reply_to_message_id: root.message_id,
  });
  await page.route(/\/v1\/projects\/[^/]+\/inbox\?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { events: [], next_cursor: "MA", has_more: false } }),
    }),
  );
  await page.goto("/");
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", project);
  await page.fill("#agent-id", "reply-dashboard");
  await page.click("button[type=submit]");
  await expect(page.getByText("Conectado (WS)")).toBeVisible();
  await expect(page.locator(".message-body").filter({ hasText: root.body })).toHaveCount(0);
  const row = page
    .getByRole("article")
    .filter({ has: page.locator(".message-body", { hasText: priorReply.body }) });
  await row.locator("summary").click();
  await expect(row.locator("blockquote")).toContainText(root.body);
  // History was isolated only to prove lazy loading of an older original.
  // Restore the real inbox for the live reply and its explicit ACK path.
  await page.unroute(/\/v1\/projects\/[^/]+\/inbox\?/);
  await row.getByRole("button", { name: /^Responder a/ }).click();
  await expect(page.getByText("Respondiendo a writer", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Audiencia", { exact: true })).toHaveValue("private");
  await expect(page.locator("#message-audience-choice option[value=public]")).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /^offline-bob/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^writer/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^outsider/ })).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .locator(".message-composer")
    .screenshot({ path: testInfo.outputPath("reply-mobile.png") });
  await page
    .getByLabel("Mensaje", { exact: true })
    .fill("Respuesta enviada sin copiar identificadores");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(
    page
      .locator(".message-body")
      .filter({ hasText: "Respuesta enviada sin copiar identificadores" }),
  ).toHaveCount(1);
  const reply = server.ctx.messageService
    .getHistory(project, "reply-dashboard", undefined, { thread: root.message_id })
    .messages.find((message) => message.body === "Respuesta enviada sin copiar identificadores");
  expect(reply?.recipient_agent_ids).toEqual(["writer", "offline-bob"]);
  expect(reply?.reply_to_message_id).toBe(priorReply.message_id);
  expect(
    server.ctx.messageService.getHistory(project, "outsider", undefined, {
      thread: root.message_id,
    }).messages,
  ).toEqual([]);
  await row.getByRole("button", { name: /^Ver conversación de/ }).click();
  await expect(page.getByText("Conversación seleccionada", { exact: true })).toBeVisible();
  await expect(page.locator(".message-body")).toHaveCount(3);
  await expect(page.locator(".message-body").filter({ hasText: root.body })).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("thread-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Volver a todos los mensajes", exact: true }).click();
  await page.getByLabel("Audiencia", { exact: true }).selectOption("private");
  await expect(page.getByRole("checkbox", { name: /^outsider/ })).toBeVisible();
});

test("renovación responsive conserva borradores y permite navegar con teclado", async ({
  page,
}, testInfo) => {
  const project = server.ctx.projectService.createProject("Coordinación de producto", testUserId)
    .project.project_id;
  const teammate = server.ctx.sessionService.joinProject(project, "frontend-agent", testUserId);
  server.ctx.statusService.reportStatus(project, teammate.agent_id, {
    objective: "Renovar la experiencia de colaboración",
    progress: "in_progress",
    decision: "Conservar los contratos y la privacidad de mensajes",
    next_step: "Revisar los flujos con el equipo",
  });
  server.ctx.messageService.sendMessage(project, teammate.agent_id, {
    channel: "general",
    body: "La revisión de la interfaz está lista. ¿Podemos comprobar el flujo de mensajes y las reservas de archivos?",
    priority: "high",
  });
  server.ctx.lockService.claimLock(project, teammate.agent_id, {
    paths: ["src/components/conversation/MessageComposerWithAnIntentionallyLongFilename.tsx"],
    reason: "Ajustar el formulario de mensajes",
    ttl_seconds: 600,
  });
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("connect-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: testInfo.outputPath("connect-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", project);
  await page.fill("#agent-id", "design-review");
  await page.click("button[type=submit]");
  await expect(page.getByText("Conectado (WS)")).toBeVisible();
  await page.getByLabel("Mensaje", { exact: true }).fill("Borrador que debe conservarse");
  await page.getByLabel("Filtro texto", { exact: true }).fill("interfaz");
  await page.getByRole("button", { name: "Equipo", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Equipo", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByText("Renovar la experiencia de colaboración", { exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Mensajes", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue(
    "Borrador que debe conservarse",
  );
  await expect(page.getByLabel("Filtro texto", { exact: true })).toHaveValue("interfaz");
  await page.getByRole("button", { name: "Más filtros", exact: true }).click();
  await expect(page.getByLabel("Filtro desde", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Menos filtros", exact: true }).click();
  await expect(page.getByLabel("Filtro desde", { exact: true })).toBeHidden();
  await page.getByLabel("Filtro texto", { exact: true }).fill("");
  await page.getByLabel("Mensaje", { exact: true }).fill("");
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const section of ["messages", "agents", "locks", "members"]) {
      await page.getByTestId(`tab-${section}`).click();
      await expect(page.getByTestId(`tab-${section}`)).toHaveAttribute("aria-current", "page");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (width === 375 || width === 1440) {
        await page.screenshot({
          path: testInfo.outputPath(`${section}-${width}.png`),
          fullPage: true,
        });
      }
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 667, height: 375 });
  await page.getByTestId("tab-messages").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel("Mensaje", { exact: true }).fill("Envío comprobado con teclado");
  await page.getByLabel("Mensaje", { exact: true }).press("Control+Enter");
  await expect(page.getByText("Envío comprobado con teclado", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Mensaje enviado.", { exact: true })).toBeVisible();
});

test("dos pestañas con el mismo nombre no comparten sesión y recargar permite reanudar", async ({
  page,
  browser,
}) => {
  const project = server.ctx.projectService.createProject("Instance UI", testUserId).project
    .project_id;
  const connect = async (target: typeof page) => {
    await target.goto("/");
    await target.fill("#hub-url", HUB_URL);
    await target.fill("#auth-token", authToken);
    await target.fill("#project-id", project);
    await target.fill("#agent-id", "exclusive-dashboard");
    await target.click("button[type=submit]");
  };
  await connect(page);
  await expect(page.getByText("Conectado (WS)")).toBeVisible();
  const original = server.ctx.sessionService.getActiveSessions(project)[0];
  const context = await browser.newContext();
  try {
    const duplicate = await context.newPage();
    await connect(duplicate);
    await expect(duplicate.getByText("STATE_CONFLICT", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
  await page.locator("textarea").fill("La primera pestaña sigue conectada");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByText("La primera pestaña sigue conectada", { exact: true })).toHaveCount(
    1,
  );
  await page.reload();
  await expect
    .poll(() => server.ctx.sessionService.getSessionById(original?.session_id ?? "").status)
    .toBe("disconnected");
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", project);
  await page.fill("#agent-id", "exclusive-dashboard");
  await page.click("button[type=submit]");
  await expect(page.getByText("Conectado (WS)")).toBeVisible();
  const resumed = server.ctx.sessionService.getActiveSessions(project)[0];
  expect(resumed?.session_id).not.toBe(original?.session_id);
});

test("historial paginado sobrevive recarga y muestra mensajes entrantes sin duplicados", async ({
  page,
}) => {
  const project = server.ctx.projectService.createProject("History UI", testUserId).project
    .project_id;
  server.ctx.sessionService.joinProject(project, "history-sender", testUserId);
  for (let index = 0; index < 52; index++) {
    const message = server.ctx.messageService.sendMessage(project, "history-sender", {
      channel: "general",
      body: `History message ${index}`,
      priority: "normal",
    });
    server.ctx.db
      .prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
      .run(`2026-10-08T09:00:${String(index).padStart(2, "0")}.000Z`, message.message_id);
  }
  server.ctx.messageService.sendMessage(project, "history-sender", {
    channel: "releases",
    body: "Unique release filter target",
    priority: "normal",
  });
  await page.route(/\/v1\/projects\/[^/]+\/inbox\?/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { events: [], next_cursor: "MA", has_more: false },
        request_id: "history-e2e",
      }),
    });
  });
  const connect = async () => {
    await page.fill("#hub-url", HUB_URL);
    await page.fill("#auth-token", authToken);
    await page.fill("#project-id", project);
    await page.fill("#agent-id", "history-dashboard");
    await page.click("button[type=submit]");
    await expect(page.getByText("Conectado (WS)")).toBeVisible();
  };

  await page.goto("/");
  await connect();
  await expect(page.getByText("History message 51", { exact: true })).toBeVisible();
  await expect(page.getByText("History message 0", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cargar mensajes anteriores" }).click();
  await expect(page.getByText("History message 0", { exact: true })).toBeVisible();

  const initialSession = server.ctx.sessionService
    .getActiveSessions(project)
    .find((session) => session.agent_id === "history-dashboard");
  await page.reload();
  if (
    server.ctx.sessionService.getSessionById(initialSession?.session_id ?? "").status !==
    "disconnected"
  )
    server.ctx.sessionService.disconnect(project, "history-dashboard");
  await connect();
  await expect(page.getByText("History message 0", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cargar mensajes anteriores" }).click();
  await expect(page.getByText("History message 0", { exact: true })).toHaveCount(1);

  await page.getByLabel("Filtro texto").fill("unique release");
  await page.getByLabel("Filtro canal").fill("releases");
  await page.getByRole("button", { name: "Más filtros", exact: true }).click();
  await page.getByLabel("Filtro remitente").fill("history-sender");
  await page.getByRole("button", { name: "Aplicar filtros" }).click();
  await expect(page.getByText("Unique release filter target", { exact: true })).toHaveCount(1);
  await expect(page.getByText("History message 51", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Limpiar" }).click();
  await expect(page.getByText("History message 51", { exact: true })).toHaveCount(1);

  server.ctx.messageService.sendMessage(project, "history-sender", {
    channel: "general",
    body: "Live message merged once",
    priority: "high",
  });
  const resumedSession = server.ctx.sessionService
    .getActiveSessions(project)
    .find((session) => session.agent_id === "history-dashboard");
  await page.reload();
  if (
    server.ctx.sessionService.getSessionById(resumedSession?.session_id ?? "").status !==
    "disconnected"
  )
    server.ctx.sessionService.disconnect(project, "history-dashboard");
  await connect();
  await expect(page.getByText("Live message merged once", { exact: true })).toHaveCount(1);
});

test("historial vencido requiere revisión y aceptación explícita antes de recuperar mensajes retenidos", async ({
  page,
}) => {
  const project = server.ctx.projectService.createProject("Retention UI", testUserId).project
    .project_id;
  const sender = server.ctx.sessionService.joinProject(project, "retention-sender", testUserId);
  server.ctx.statusService.reportStatus(project, sender.agent_id, {
    objective: "Contrato vigente",
    progress: "in_progress",
  });
  server.ctx.lockService.claimLock(project, sender.agent_id, {
    paths: ["src/current"],
    reason: "Current work",
    ttl_seconds: 300,
  });
  server.ctx.messageService.sendMessage(project, sender.agent_id, {
    body: "Mensaje borrado por retención",
    channel: "general",
    priority: "normal",
  });
  server.ctx.db
    .prepare("UPDATE events SET occurred_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ?")
    .run(project);
  server.ctx.db
    .prepare("UPDATE messages SET created_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ?")
    .run(project);
  server.ctx.eventBus.pruneEventsBefore("2001-01-01T00:00:00.000Z");
  server.ctx.db
    .prepare("DELETE FROM messages WHERE project_id = ? AND created_at < ?")
    .run(project, "2001-01-01T00:00:00.000Z");
  server.ctx.messageService.sendMessage(project, sender.agent_id, {
    body: "Mensaje conservado después de retención",
    channel: "general",
    priority: "normal",
  });
  await page.goto("/");
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", project);
  await page.fill("#agent-id", "retention-dashboard");
  await page.click("button[type=submit]");
  await expect(page.getByText("CURSOR_EXPIRED", { exact: true })).toBeVisible();
  const session = server.ctx.sessionService
    .getActiveSessions(project)
    .find((session) => session.agent_id === "retention-dashboard");
  expect(session?.last_cursor).toBe("MA");
  await expect(
    page.getByText("Mensaje conservado después de retención", { exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Revisar estado actual" }).click();
  await expect(page.getByText(/retention-sender: Contrato vigente/)).toBeVisible();
  await expect(page.getByText(/Rutas bloqueadas: src\/current/)).toBeVisible();
  expect(server.ctx.sessionService.getSessionById(session?.session_id ?? "").last_cursor).toBe(
    "MA",
  );
  await page.getByRole("button", { name: "Aceptar historial perdido y continuar" }).click();
  await expect(
    page.getByText("Mensaje conservado después de retención", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Mensaje borrado por retención", { exact: true })).toHaveCount(0);
  await expect(page.getByText("CURSOR_EXPIRED", { exact: true })).toHaveCount(0);
});

test("invitación UI con identidades distintas y revocación de acceso", async ({
  page,
  browser,
}) => {
  const friendId = crypto.randomUUID();
  server.ctx.db
    .prepare("INSERT INTO users VALUES (?, ?, ?)")
    .run(friendId, "e2e-friend", new Date().toISOString());
  const friendToken = server.ctx.authService.createToken(friendId, "agents-hub");
  await page.goto("/");
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", testProjectId);
  await page.fill("#agent-id", "invite-owner");
  await page.click("button[type=submit]");
  await page.getByTestId("tab-members").click();
  await page.getByRole("button", { name: "Crear invitación" }).click();
  await expect(page.locator("#new-invitation")).toHaveValue(/^ahi_/);
  const invitation = await page.locator("#new-invitation").inputValue();
  const context = await browser.newContext();
  const friendPage = await context.newPage();
  try {
    await friendPage.goto("/");
    await friendPage.fill("#hub-url", HUB_URL);
    await friendPage.fill("#auth-token", friendToken);
    await friendPage.fill("#project-id", testProjectId);
    await friendPage.fill("#agent-id", "friend-dashboard");
    await friendPage.fill("#invitation", invitation);
    await friendPage.click("button[type=submit]");
    await expect(friendPage.getByText("Conectado (WS)")).toBeVisible();
    await friendPage.locator("textarea").fill("Mensaje de un amigo con identidad propia");
    await friendPage.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByTestId("tab-messages").click();
    await expect(page.getByText("Mensaje de un amigo con identidad propia")).toHaveCount(1);
    await server.inject({
      method: "DELETE",
      url: `/v1/projects/${testProjectId}/members/${friendId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    await expect(friendPage.getByText("Conectado (WS)")).toHaveCount(0);
    await expect
      .poll(() =>
        server.ctx.sessionService
          .getActiveSessions(testProjectId)
          .some((s) => s.agent_id === "friend-dashboard"),
      )
      .toBe(false);
  } finally {
    await context.close();
  }
});

test("recupera un ACK fallido con WS abierto sin duplicados y polling si WS no vuelve", async ({
  page,
}) => {
  await page.goto("/");
  await page.fill("#hub-url", HUB_URL);
  await page.fill("#auth-token", authToken);
  await page.fill("#project-id", testProjectId);
  await page.fill("#agent-id", "ack-recovery");
  await page.click("button[type=submit]");
  await expect(page.getByText("Conectado (WS)")).toBeVisible();
  let failed = false;
  await page.route("**/inbox/ack", async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "Retry ACK" } }),
      });
    } else await route.continue();
  });
  server.ctx.messageService.sendMessage(testProjectId, "invite-owner", {
    body: "ACK perdido, mensaje único",
    channel: "general",
    priority: "normal",
  });
  await expect(page.getByText("ACK perdido, mensaje único")).toHaveCount(1);
  await expect(page.getByText("Límite de peticiones alcanzado")).toBeVisible();
  await expect(page.getByText("Límite de peticiones alcanzado")).toHaveCount(0, { timeout: 7000 });
  await expect(page.getByText("ACK perdido, mensaje único")).toHaveCount(1);
  await page.route("**/ws-ticket", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "WS unavailable" } }),
    }),
  );
  await page.evaluate(() =>
    (
      window as unknown as { __agentsHubTestRealtime: { forceCloseSocketForTest(): void } }
    ).__agentsHubTestRealtime.forceCloseSocketForTest(),
  );
  server.ctx.messageService.sendMessage(testProjectId, "invite-owner", {
    body: "Recibido mediante polling",
    channel: "general",
    priority: "normal",
  });
  await expect(page.getByText("Recibido mediante polling")).toHaveCount(1, { timeout: 8000 });
  await page.getByRole("button", { name: "Desconectar", exact: true }).click();
  await expect
    .poll(() =>
      server.ctx.sessionService
        .getActiveSessions(testProjectId)
        .some((s) => s.agent_id === "ack-recovery"),
    )
    .toBe(false);
});

test.describe("Agents-Hub Web Dashboard (Producción y Resiliencia)", () => {
  test("flujo principal en producción: conexión con ticket efímero, mensajes, locks y cero tokens en storage", async ({
    page,
  }) => {
    // 1. Acceso a la página inicial
    await page.goto("/");
    await expect(page).toHaveTitle(/Agents-Hub/);
    await expect(page.getByRole("heading", { name: "Agents-Hub" })).toBeVisible();

    // 2. Formulario de conexión / login
    await page.fill("#hub-url", HUB_URL);
    await page.fill("#auth-token", authToken);
    await page.fill("#project-id", testProjectId);
    await page.fill("#agent-id", "e2e-agent");

    await page.click("button[type='submit']");

    // 3. Verificación de Shell e ingreso exitoso
    await expect(page.getByText("E2E Test Space")).toBeVisible();
    await expect(page.getByText(/Conectado \(WS\)/)).toBeVisible();
    await expect(page.getByText("e2e-agent")).toBeVisible();

    // 4. Seguridad estricta: verificar que el token NO se expone en URL, localStorage ni sessionStorage
    expect(page.url()).not.toContain(authToken);
    expect(page.url()).not.toContain("ah_");

    const storages = await page.evaluate(() => ({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
    }));

    const serializedStorage = JSON.stringify(storages);
    expect(serializedStorage).not.toContain(authToken);
    expect(serializedStorage).not.toContain("ah_");

    // 5. Flujo de Mensajes: Enviar y visualizar mensaje
    await page.click("button[data-testid='tab-messages']");
    const messageInput = page.locator("textarea[placeholder*='Escribe un mensaje']");
    await messageInput.fill("Hola equipo, coordinando entrega de módulo de autenticación");
    await page.click("button:has-text('Enviar')");

    // Verificar que el mensaje aparece en el feed
    await expect(
      page.getByText("Hola equipo, coordinando entrega de módulo de autenticación"),
    ).toBeVisible();
    await expect(page.locator("span.font-mono:has-text('e2e-agent')").first()).toBeVisible();
    await expect(page.locator("span.font-mono:has-text('#general')").first()).toBeVisible();

    // 6. Flujo de Locks: Reclamar y Liberar lock
    await page.click("button[data-testid='tab-locks']");
    await expect(page.getByText("Locks de Archivos y Módulos")).toBeVisible();

    const pathsInput = page.locator("#lock-paths");
    const reasonInput = page.locator("#lock-reason");
    await pathsInput.fill("src/auth/guard.ts");
    await reasonInput.fill("Refactorizando autorización basada en roles");
    await page.click("button:has-text('Reclamar Lock')");

    // Verificar que el lock aparece activo
    await expect(page.getByText("src/auth/guard.ts")).toBeVisible();
    await expect(page.getByText("Refactorizando autorización basada en roles")).toBeVisible();
    await expect(page.getByText("Mi Lock")).toBeVisible();

    const lock = server.ctx.lockService
      .getActiveLocks(testProjectId)
      .find((current) => current.owner_agent_id === "e2e-agent");
    expect(lock).toBeDefined();
    await page.locator("#lock-ttl").fill("600");
    let renewalRequests = 0;
    const keys: string[] = [];
    await page.route(/\/locks\/[^/]+\/renew$/, async (route) => {
      keys.push(route.request().postDataJSON().idempotency_key);
      const response = await route.fetch();
      if (++renewalRequests === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: `Renovar lock ${lock?.lock_id}` }).click();
    await expect
      .poll(
        () =>
          server.ctx.lockService
            .getActiveLocks(testProjectId)
            .find((current) => current.lock_id === lock?.lock_id)?.ttl_seconds,
      )
      .toBe(600);
    await expect.poll(() => renewalRequests).toBe(2);
    expect(new Set(keys).size).toBe(1);
    await expect(page.getByText(/Expira en: 9m/)).toBeVisible();

    // Liberar el lock
    await page.click("button:has-text('Liberar')");
    // Verificar que desaparece
    await expect(page.getByText("No hay locks activos")).toBeVisible();

    // 7. Flujo de Presencia y Estados
    await page.click("button[data-testid='tab-agents']");
    await expect(page.getByText("Presencia y Estados del Equipo")).toBeVisible();

    const objectiveInput = page.locator("#agent-objective");
    await objectiveInput.fill("Completando pruebas de integración Playwright");
    await page.selectOption("#agent-progress", "completed");
    await page.click("button:has-text('Publicar Estado')");

    // Verificar que el estado actualizado se muestra
    await expect(page.getByText("Completando pruebas de integración Playwright")).toBeVisible();
    await expect(page.locator("span:has-text('Completado')")).toBeVisible();

    // 8. Desconexión manual limpia
    await page.click("button:has-text('Desconectar')");
    await expect(page.getByRole("heading", { name: "Agents-Hub" })).toBeVisible();
    await expect(page.getByText("Conectar Proyecto")).toBeVisible();
  });

  test("creación de nuevo proyecto desde UI y manejo de error con token inválido", async ({
    page,
  }) => {
    await page.goto("/");

    // 1. Intentar conectar con token inválido
    await page.fill("#hub-url", HUB_URL);
    await page.fill("#auth-token", "ah_token_invalido");
    await page.fill("#project-id", testProjectId);
    await page.click("button[type='submit']");

    // Verificar que se muestra el error devuelto por el servidor
    await expect(page.locator("div[role='alert']")).toBeVisible();
    await expect(page.getByText("UNAUTHENTICATED", { exact: true })).toBeVisible();

    // 2. Cambiar a modo 'Crear Proyecto' y crear proyecto con token válido
    await page.click("button:has-text('Crear Proyecto')");
    await page.fill("#auth-token", authToken);
    await page.fill("#project-name", "Proyecto Creado E2E");
    await page.fill("#agent-id", "creador-agente");
    await page.click("button:has-text('Crear y Conectar')");

    // Verificar ingreso exitoso al nuevo proyecto
    await expect(page.getByText("Proyecto Creado E2E")).toBeVisible();
    await expect(page.getByText(/Conectado/)).toBeVisible();
    await expect(page.getByText("creador-agente")).toBeVisible();
  });

  test("reconexión real forzada, recuperación por inbox sin duplicados y confirmación de cursor", async ({
    page,
  }) => {
    // 1. Conectar al proyecto
    await page.goto("/");
    await page.fill("#hub-url", HUB_URL);
    await page.fill("#auth-token", authToken);
    await page.fill("#project-id", testProjectId);
    await page.fill("#agent-id", "reconnect-test-agent");
    await page.click("button[type='submit']");

    await expect(page.getByText("E2E Test Space")).toBeVisible();
    await expect(page.getByText(/Conectado \(WS\)/)).toBeVisible();

    await page.click("button[data-testid='tab-messages']");

    // 2. Forzar cierre del WebSocket en el cliente
    await page.evaluate(() => {
      const rt = (
        window as unknown as {
          __agentsHubTestRealtime?: { forceCloseSocketForTest: () => void };
        }
      ).__agentsHubTestRealtime;
      rt?.forceCloseSocketForTest();
    });

    // 3. Confirmar que la UI detecta la caída
    await expect(page.getByText(/Reconectando|Desconectado/)).toBeVisible();

    // 4. Publicar un mensaje en el hub desde otro agente mientras el socket está cerrado
    server.ctx.sessionService.joinProject(testProjectId, "offline-sender", testUserId);
    server.ctx.messageService.sendMessage(testProjectId, "offline-sender", {
      channel: "general",
      body: "Mensaje publicado mientras el WebSocket estaba caído",
      priority: "high",
    });

    // 5. Verificar que el cliente recupera el mensaje mediante polling o reconexión
    const recoveredMessage = page.getByText("Mensaje publicado mientras el WebSocket estaba caído");
    await expect(recoveredMessage).toBeVisible({ timeout: 12000 });

    // 6. Confirmar que el mensaje aparece EXACTAMENTE UNA VEZ (sin duplicados)
    await expect(recoveredMessage).toHaveCount(1);

    // 7. Esperar y validar que el cursor fue confirmado (ACK) en el backend para la sesión
    await expect
      .poll(
        () => {
          const sessions = server.ctx.sessionService.getActiveSessions(testProjectId);
          const current = sessions.find((s) => s.agent_id === "reconnect-test-agent");
          return current?.last_cursor;
        },
        { timeout: 8000 },
      )
      .not.toBeNull();
  });

  test("evita polling periódico y recibe mensajes nuevos por WebSocket activo", async ({
    page,
  }) => {
    let inboxRequestsCount = 0;

    page.on("request", (req) => {
      if (req.url().includes("/v1/projects/") && req.url().includes("/inbox")) {
        inboxRequestsCount++;
      }
    });

    // 1. Conectar y esperar a que el WebSocket esté listo
    await page.goto("/");
    await page.fill("#hub-url", HUB_URL);
    await page.fill("#auth-token", authToken);
    await page.fill("#project-id", testProjectId);
    await page.fill("#agent-id", "no-redundant-poll-agent");
    await page.click("button[type='submit']");

    await expect(page.getByText("E2E Test Space")).toBeVisible();
    await expect(page.getByText(/Conectado \(WS\)/)).toBeVisible();

    await page.click("button[data-testid='tab-messages']");

    // Registrar cantidad inicial tras carga inicial del feed
    const initialCount = inboxRequestsCount;
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Esperar 4 segundos con WebSocket activo
    await page.waitForTimeout(4000);

    // Asegurarse de que MessageFeed NO está ejecutando interval polling redundante
    // No deberían haberse realizado nuevas solicitudes al inbox
    expect(inboxRequestsCount).toBe(initialCount);

    server.ctx.sessionService.joinProject(testProjectId, "live-sender", testUserId);
    server.ctx.messageService.sendMessage(testProjectId, "live-sender", {
      channel: "general",
      body: "Evento vivo después del recovery inicial",
      priority: "normal",
    });
    await expect(page.getByText("Evento vivo después del recovery inicial")).toHaveCount(1);
  });
});
