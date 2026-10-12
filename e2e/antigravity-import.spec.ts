import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildApp } from "../apps/hub-server/src/app.js";
import { AntigravityImporter } from "../apps/hub-server/src/local/antigravity-importer.js";
import { ConnectionAssistant } from "../apps/hub-server/src/local/connection-assistant.js";
import { buildLocalControl } from "../apps/hub-server/src/local/control-app.js";
import { privateDirectory, verifyPrivatePath } from "../packages/config/dist/index.js";

test("importación gráfica cancelable conserva MCP ajeno en perfil TEMP", async ({ page }, info) => {
  test.setTimeout(60000); // New scenario includes writer setup + private ACLs + two previews; historical tests unchanged.
  const root = await mkdtemp(path.join(tmpdir(), "ah-client-import-e2e-"));
  const values = new Map<string, string>();
  const token = `ah_${"s".repeat(32)}`;
  const expires = new Date(Date.now() + 300000).toISOString();
  const foreign = {
    mcpServers: { other: { command: "do-not-run", env: { TOKEN: "synthetic-foreign-secret" } } },
    otherSetting: true,
  };
  const hub = buildApp();
  const importer = new AntigravityImporter(root, async () => "1.3.3"); // No commercial CLI/config access.
  const assistant = new ConnectionAssistant(
    path.join(root, "connections"),
    path.resolve("packages/mcp-server/dist/main.js"),
    process.execPath,
    async (url) =>
      new Response(
        JSON.stringify({
          data: String(url).endsWith("/requests")
            ? {
                request_id: randomUUID(),
                expires_at: expires,
                device_secret: `ahd_${"s".repeat(43)}`,
              }
            : { token, token_id: randomUUID(), project_id: randomUUID(), expires_at: expires },
        }),
      ),
    {
      put: async (id, value) => {
        values.set(id, value);
      },
      get: async (id) => values.get(id),
      remove: async (id) => {
        values.delete(id);
      },
    },
    importer,
  );
  const control = buildLocalControl(
    {
      context: () => hub.ctx,
      status: () => ({ hub: "stopped", sharing: "stopped", portal_url: null }),
      start: async () => {},
      stop: async () => {},
      share: async () => {},
      stopSharing: async () => {},
    },
    "http://127.0.0.1:8830",
    path.resolve("apps/web/dist"),
    Date.now,
    undefined,
    undefined,
    assistant,
  );
  try {
    await privateDirectory(path.join(root, ".gemini"));
    await privateDirectory(path.join(root, ".gemini", "config"));
    const original = JSON.stringify(foreign, null, 4);
    await writeFile(importer.destination, original, { flag: "wx", mode: 0o600 });
    await verifyPrivatePath(importer.destination, true);
    const start = await assistant.start({
      hub_url: "https://hub.example",
      label: "Importación TEMP",
    });
    const saved = await assistant.finish({ connection_id: start.connection_id, confirm: true });
    await control.app.listen({ host: "127.0.0.1", port: 8830 });
    const loaded = page.waitForResponse(
      (response) =>
        response.url() === "http://127.0.0.1:8830/local-api/connections" &&
        response.request().method() === "GET",
    );
    await page.goto(control.bootstrapUrl);
    const list = await loaded;
    expect(list.ok()).toBe(true);
    expect(await list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connection_id: start.connection_id, state: "saved" }),
      ]),
    );
    const trigger = page.getByRole("button", { name: "Conectar con Antigravity CLI", exact: true });
    await expect(trigger).toBeEnabled();
    // Exercise the parent's selected-connection focus path, not only an already-saved profile.
    await page.getByLabel("URL del Hub (obligatoria)").fill("https://hub.example");
    await page.getByLabel("Nombre de este dispositivo (obligatorio)").fill("Otro intento TEMP");
    const prepared = page.waitForResponse(
      (response) =>
        response.url().endsWith("/local-api/connections") && response.request().method() === "GET",
    );
    await page.getByRole("button", { name: "Preparar conexión", exact: true }).click();
    expect((await prepared).ok()).toBe(true);
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByRole("heading", { name: "Revisar importación" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Confirmar importación" })).toBeDisabled();
    const client = page.getByRole("region", { name: "Conexión con Antigravity CLI" });
    await expect(client).toContainText("1 entrada actual");
    await page.screenshot({ path: info.outputPath("import-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("import-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancelar importación" }).click();
    await expect(trigger).toBeFocused();
    expect(await readFile(importer.destination, "utf8")).toBe(original);
    await trigger.click();
    await page.getByLabel("Cerré Antigravity y autorizo registrar esta conexión").check();
    const applied = page.waitForResponse((response) =>
      response.url().endsWith("/connections/import/apply"),
    );
    await page.getByRole("button", { name: "Confirmar importación" }).click();
    const response = await applied;
    expect(response.ok()).toBe(true);
    const result = await response.json();
    await expect(client).toContainText("MCP registrado, todavía no conectado");
    await expect(client.getByRole("status")).toBeFocused();
    const config = JSON.parse(await readFile(importer.destination, "utf8"));
    expect(config).toEqual({
      ...foreign,
      mcpServers: { ...foreign.mcpServers, ...saved.config.mcpServers },
    });
    expect(await readFile(result.backup, "utf8")).toBe(original);
    expect(await client.textContent()).not.toContain("synthetic-foreign-secret");
    expect(await client.textContent()).not.toContain(token);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).toBe(
      "[{},{}]",
    );
    await page.screenshot({ path: info.outputPath("import-result-mobile.png"), fullPage: true });
  } finally {
    await control.app.close();
    await hub.close();
    hub.ctx.db.close();
    if (
      path.dirname(root) === path.resolve(tmpdir()) &&
      path.basename(root).startsWith("ah-client-import-e2e-")
    )
      await rm(root, { recursive: true, force: true });
  }
});
