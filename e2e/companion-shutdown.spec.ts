import { type ChildProcess, fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createCompanionData, removeCompanionData } from "./isolated-companion.js";

test("panel closes only its companion and reopens with persistent data", async ({
  page,
  request,
}, testInfo) => {
  const data = await createCompanionData();
  const hub = "http://127.0.0.1:8814";
  let child: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  async function launch() {
    const own = fork("apps/hub-server/dist/companion.js", [], {
      env: {
        ...process.env,
        DATABASE_URL: path.join(data, "shutdown.sqlite"),
        AGENTS_HUB_DATA_DIR: data,
        PORT: "8814",
        LOCAL_CONTROL_PORT: "8815",
        AGENTS_HUB_NO_BROWSER: "1",
        LOG_LEVEL: "fatal",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    child = own;
    exit = new Promise((resolve) => own.once("exit", resolve));
    own.stdout?.resume();
    own.stderr?.resume();
    const entry = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Own companion not ready")), 15000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Own companion failed"));
      };
      own.once("error", fail);
      own.once("exit", fail);
      own.on("message", (message) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "ready" &&
          "url" in message &&
          typeof message.url === "string"
        ) {
          clearTimeout(timer);
          resolve(message.url);
        }
      });
    });
    await page.goto(entry);
    await expect(page.getByRole("heading", { name: "Personas", exact: true })).toBeVisible();
  }
  async function closeFromPanel() {
    await page.getByRole("button", { name: "Cerrar Agents-Hub", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancelar cierre" })).toBeFocused();
    await page.getByRole("button", { name: "Confirmar cierre de Agents-Hub" }).press("Enter");
    await expect(
      page.getByRole("heading", { name: "Cierre de Agents-Hub solicitado" }),
    ).toBeFocused();
    await expect.poll(() => child?.exitCode).toBe(0);
    expect(await exit).toBe(0);
    await expect(request.get(`${hub}/health/live`, { timeout: 2000 })).rejects.toThrow();
    await expect(page.getByRole("button", { name: "Actualizar estado" })).toHaveCount(0);
    await expect(readFile(path.join(data, ".companion-control/instance.json"))).rejects.toThrow();
  }
  try {
    await launch();
    await page.getByLabel("Tu nombre para el equipo").fill("shutdown-owner");
    await page.getByLabel("Nombre del primer proyecto").fill("Preserved after shutdown");
    await page.getByRole("button", { name: "Preparar proyecto" }).click();
    await expect(page.getByRole("status")).toContainText("Proyecto preparado");
    await page.getByRole("button", { name: "Iniciar Hub", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Hub iniciado");
    expect((await request.get(`${hub}/health/live`)).status()).toBe(200);
    expect(
      (
        await request.post(`${hub}/local-api/companion/shutdown`, { data: { confirm: true } })
      ).status(),
    ).toBe(404);
    await page.getByRole("button", { name: "Cerrar Agents-Hub", exact: true }).click();
    await page.getByRole("button", { name: "Cancelar cierre" }).press("Enter");
    await expect(
      page.getByRole("button", { name: "Cerrar Agents-Hub", exact: true }),
    ).toBeFocused();
    expect((await request.get(`${hub}/health/live`)).status()).toBe(200);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Cerrar Agents-Hub", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("shutdown-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancelar cierre" }).click();
    await closeFromPanel();
    await launch();
    await expect(page.getByRole("button", { name: "Iniciar Hub", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Proyectos e invitaciones", exact: true }).click();
    await expect(
      page.getByRole("listitem").getByText("Preserved after shutdown", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Cerrar Agents-Hub", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("shutdown-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Cancelar cierre" }).click();
    await closeFromPanel();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: "shutdown" });
      const timer = setTimeout(() => child?.kill(), 5000);
      await exit;
      clearTimeout(timer);
    }
    await removeCompanionData(data);
  }
});
