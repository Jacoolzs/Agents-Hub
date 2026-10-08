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
    NODE_ENV: "development",
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

test.describe("Agents-Hub Web Dashboard", () => {
  test("flujo principal: login, mensaje, lock, presencia y reconexión sin exponer tokens", async ({
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
    await expect(page.getByText(/Conectado/)).toBeVisible();
    await expect(page.getByText("e2e-agent")).toBeVisible();

    // 4. Seguridad: verificar que el token NO se expone en URL ni en localStorage
    expect(page.url()).not.toContain(authToken);
    expect(page.url()).not.toContain("ah_");
    const storedToken = await page.evaluate(() => localStorage.getItem("token"));
    expect(storedToken).toBeNull();

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

  test("recuperación de mensajes de otros agentes vía inbox y actualización en tiempo real", async ({
    page,
  }) => {
    // 1. Ingresar con dashboard observer
    await page.goto("/");
    await page.fill("#hub-url", HUB_URL);
    await page.fill("#auth-token", authToken);
    await page.fill("#project-id", testProjectId);
    await page.fill("#agent-id", "dashboard-observer");
    await page.click("button[type='submit']");

    await expect(page.getByText("E2E Test Space")).toBeVisible();

    // 2. Un segundo agente (agent-charlie) publica un mensaje en el hub
    server.ctx.sessionService.joinProject(testProjectId, "agent-charlie", testUserId);
    server.ctx.messageService.sendMessage(testProjectId, "agent-charlie", {
      channel: "dev",
      body: "Mensaje asíncrono desde Agent Charlie para verificación de inbox",
      priority: "urgent",
    });

    // 3. Cambiar filtro a canal #dev o todos los canales y verificar que el dashboard recibe el mensaje
    await page.click("button[data-testid='tab-messages']");
    await expect(
      page.getByText("Mensaje asíncrono desde Agent Charlie para verificación de inbox"),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator("span.font-mono:has-text('agent-charlie')")).toBeVisible();
    await expect(page.locator("span:has-text('Urgente')")).toBeVisible();
  });
});
