import { expect, test } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { type AppContext, buildApp } from "../apps/hub-server/src/app.js";

let server: FastifyInstance & { ctx: AppContext };
const PORT = 8787;
const HUB_URL = `http://127.0.0.1:${PORT}`;
let authToken = "";
let testProjectId = "";
const testUserId = "user-playwright-tester";

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
  }
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

  test("evita solicitudes redundantes al inbox mientras el WebSocket está conectado", async ({
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
  });
});
