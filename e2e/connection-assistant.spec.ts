import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildApp } from "../apps/hub-server/src/app.js";
import { ConnectionAssistant } from "../apps/hub-server/src/local/connection-assistant.js";
import { buildLocalControl } from "../apps/hub-server/src/local/control-app.js";

// Real HTTP/UI with synthetic isolated vault; native providers have separate tests.
test("asistente gráfico revisa, guarda sin bearer, exporta y revoca", async ({
  page,
  browser,
}, info) => {
  const root = await mkdtemp(path.join(tmpdir(), "ah-assistant-e2e-"));
  const portal = "http://127.0.0.1:8823";
  const local = "http://127.0.0.1:8822";
  const hub = buildApp({
    NODE_ENV: "production",
    CORS_ORIGINS: portal,
    WEB_STATIC_DIR: path.resolve("apps/web/dist"),
  });
  const values = new Map<string, string>();
  const assistant = new ConnectionAssistant(
    path.join(root, "connections"),
    path.resolve("packages/mcp-server/dist/main.js"),
    process.execPath,
    fetch,
    {
      put: async (id, value) => {
        if (values.has(id)) throw new Error("Reserved");
        values.set(id, value);
      },
      get: async (id) => values.get(id),
      remove: async (id) => {
        values.delete(id);
      },
    },
  );
  const control = buildLocalControl(
    {
      context: () => hub.ctx,
      status: () => ({ hub: "running", sharing: "stopped", portal_url: portal }),
      start: async () => {},
      stop: async () => {},
      share: async () => {},
      stopSharing: async () => {},
    },
    local,
    path.resolve("apps/web/dist"),
    Date.now,
    undefined,
    undefined,
    assistant,
  );
  const human = await browser.newContext();
  try {
    const user = crypto.randomUUID();
    const project = hub.ctx.projectService.createProject("Asistente gráfico", user).project
      .project_id;
    await hub.listen({ host: "127.0.0.1", port: 8823 });
    await control.app.listen({ host: "127.0.0.1", port: 8822 });
    const entry = hub.ctx.webAccessService.issueEntry(user, { project_id: project }, "e2e");
    const remote = await human.newPage();
    await remote.goto(`${portal}/#entry=${entry.secret}`);
    await remote.getByLabel("Elige tu contraseña").fill("Frase segura de prueba asistente");
    await remote.getByRole("button", { name: "Entrar al proyecto", exact: true }).click();
    await expect(remote.getByRole("heading", { name: "Conversación del equipo" })).toBeVisible();
    await page.goto(control.bootstrapUrl);
    await page.getByLabel("URL del Hub (obligatoria)").fill(portal);
    await page.getByLabel("Nombre de este dispositivo (obligatorio)").fill("Mi equipo de prueba");
    await expect(
      page.getByRole("button", { name: "Preparar conexión", exact: true }),
    ).toBeEnabled();
    const prepared = page.waitForResponse(
      (response) =>
        response.url() === `${local}/local-api/connections` &&
        response.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Preparar conexión", exact: true }).click();
    expect((await prepared).ok()).toBe(true);
    const review = page.getByRole("link", { name: "Revisar en el portal" });
    await expect(review).toBeVisible();
    await expect(page.getByRole("button", { name: "Canjear y guardar" })).toBeDisabled();
    await remote.goto((await review.getAttribute("href")) as string);
    await expect(remote.getByRole("heading", { name: "Dispositivos e IA" })).toBeVisible();
    expect(remote.url()).not.toContain("#");
    await remote.getByRole("button", { name: "Revisar solicitud" }).click();
    await expect(remote.getByRole("button", { name: "Autorizar dispositivo" })).toBeDisabled();
    await expect(remote.getByText("Mi equipo de prueba", { exact: true })).toBeVisible();
    await expect(remote.getByText("Asistente gráfico", { exact: true })).toBeVisible();
    await remote.getByLabel("Reconozco este dispositivo y este proyecto").check();
    await remote.getByRole("button", { name: "Autorizar dispositivo" }).click();
    await expect(remote.getByRole("status")).toContainText("Dispositivo aprobado");
    await page.getByLabel("Ya confirmé esta solicitud en el portal").check();
    const refreshed = page.waitForResponse(
      (response) =>
        response.url() === `${local}/local-api/connections` &&
        response.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Canjear y guardar" }).click();
    expect((await refreshed).ok()).toBe(true);
    await expect(page.getByRole("status")).toContainText("Conexión guardada");
    expect(values.size).toBe(1);
    const [token] = values.values();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Descargar configuración MCP" }).click();
    const config = await readFile((await (await download).path()) as string, "utf8");
    expect(config).not.toContain(token as string);
    expect(config).not.toContain("AGENTS_HUB_TOKEN");
    expect(config).toContain("AGENTS_HUB_CONNECTION_FILE");
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).toBe(
      "[{},{}]",
    );
    const reloaded = page.waitForResponse(
      (response) =>
        response.url() === `${local}/local-api/connections` &&
        response.request().method() === "GET",
    );
    await page.reload();
    expect((await reloaded).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Descargar configuración MCP" })).toBeVisible();
    await remote.getByRole("button", { name: "Actualizar dispositivos" }).click();
    await remote.getByRole("button", { name: "Revocar dispositivo" }).click();
    await remote.getByRole("button", { name: "Confirmar revocación" }).click();
    await expect(remote.getByText("Revocada", { exact: true })).toBeVisible();
    expect(
      (
        await fetch(`${portal}/v1/projects/${project}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("connection-mobile.png"), fullPage: true });
    await remote.screenshot({ path: info.outputPath("device-desktop.png"), fullPage: true });
  } finally {
    await human.close();
    await control.app.close();
    await hub.close();
    hub.ctx.db.close();
    if (
      path.dirname(root) === path.resolve(tmpdir()) &&
      path.basename(root).startsWith("ah-assistant-e2e-")
    )
      await rm(root, { recursive: true, force: true });
  }
});
