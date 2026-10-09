import { type ChildProcess, fork } from "node:child_process";
import { expect, test } from "@playwright/test";

let child: ChildProcess;
let entry = "";
const hubUrl = "http://127.0.0.1:8795";
test.beforeAll(async () => {
  child = fork("apps/hub-server/dist/companion.js", [], {
    env: {
      ...process.env,
      DATABASE_URL: ":memory:",
      PORT: "8795",
      LOCAL_CONTROL_PORT: "8794",
      AGENTS_HUB_NO_BROWSER: "1",
      LOG_LEVEL: "fatal",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  // Drain diagnostics without printing IPC's one-use entry or fixture credentials.
  child.stdout?.resume();
  child.stderr?.resume();
  entry = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Companion did not become ready")), 15000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Companion spawn failed"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Companion exited before ready"));
    });
    child.on("message", (message) => {
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
});
test.afterAll(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.connected) child.send({ type: "shutdown" });
  const timer = setTimeout(() => child.kill(), 5000);
  await exited;
  clearTimeout(timer);
});

test("anfitrión administra y reinicia Hub desde panel privado con teclado y móvil", async ({
  page,
  request,
}, testInfo) => {
  await page.goto(entry);
  await expect(page.getByRole("heading", { name: "Personas", exact: true })).toBeVisible();
  expect(page.url()).not.toContain("#");
  await page.getByLabel("Nombre de usuario").fill("host-test");
  await page.getByLabel("Nombre de usuario").press("Enter");
  await expect(
    page.getByRole("heading", { name: "Acceso de host-test", exact: true }),
  ).toBeVisible();
  const credential = page.getByLabel("Credencial emitida");
  await expect(credential).toHaveAttribute("type", "password");
  const token = await credential.inputValue();
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    token,
  );
  await page.getByRole("button", { name: "Descartar de pantalla" }).click();
  await page.getByRole("button", { name: "Proyectos e invitaciones", exact: true }).click();
  await page.getByLabel("Nombre del proyecto").fill("Equipo de prueba local");
  await page.getByRole("button", { name: "Crear proyecto", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Proyecto creado");
  await page.getByText("Invitación avanzada con token personal", { exact: true }).click();
  await page.getByRole("button", { name: "Crear invitación avanzada", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Invitación de un solo uso" })).toBeVisible();
  await page.getByRole("button", { name: "Descartar de pantalla" }).click();
  await page.getByRole("button", { name: "Iniciar Hub", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Hub iniciado.");
  await expect(page.getByRole("button", { name: "Iniciar Hub", exact: true })).toBeDisabled();
  expect((await request.get(`${hubUrl}/health/live`)).ok()).toBe(true);
  expect((await request.get(`${hubUrl}/local-api/snapshot`)).status()).toBe(404);
  const projects = page.getByRole("listitem").filter({ hasText: "Equipo de prueba local" });
  await projects.getByText("Datos de conexión").click();
  const project = await projects.locator("code").innerText();
  expect(
    (
      await request.get(`${hubUrl}/v1/projects/${project}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole("button", { name: "Detener Hub", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Hub detenido.");
  await expect(page.getByRole("button", { name: "Iniciar Hub", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Iniciar Hub", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Hub iniciado.");
  await expect(page.getByRole("button", { name: "Iniciar Hub", exact: true })).toBeDisabled();
  expect(
    (
      await request.get(`${hubUrl}/v1/projects/${project}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole("button", { name: "Personas", exact: true }).click();
  await page.getByRole("button", { name: "Revocar acceso", exact: true }).click();
  await page.getByRole("button", { name: "Confirmar revocación" }).click();
  await expect(page.getByText("Revocado", { exact: true })).toBeVisible();
  expect(
    (
      await request.get(`${hubUrl}/v1/projects/${project}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Personas", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("control-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("control-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Cerrar sesión local" }).click();
  await expect(page.getByRole("heading", { name: "Sesión local cerrada" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("sesión local terminó");
});
