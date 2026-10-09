import { type ChildProcess, fork } from "node:child_process";
import { expect, test } from "@playwright/test";

const portal = "http://127.0.0.1:8799";
const local = "http://127.0.0.1:8798";
let child: ChildProcess;
let entry = "";
test.beforeAll(async () => {
  child = fork("apps/hub-server/dist/companion.js", [], {
    env: {
      ...process.env,
      DATABASE_URL: ":memory:",
      PORT: "8799",
      LOCAL_CONTROL_PORT: "8798",
      AGENTS_HUB_NO_BROWSER: "1",
      LOG_LEVEL: "fatal",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  entry = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Invitation companion readiness timeout")),
      15000,
    );
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Companion spawn failed"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Companion exited before ready"));
    });
    child.on("message", (m) => {
      if (
        m &&
        typeof m === "object" &&
        "type" in m &&
        m.type === "ready" &&
        "url" in m &&
        typeof m.url === "string"
      ) {
        clearTimeout(timer);
        resolve(m.url);
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

test("una persona nueva entra con un enlace y las invitaciones pendientes se pueden revocar", async ({
  page: admin,
  browser,
  request,
}, info) => {
  await admin.goto(entry);
  await admin.getByLabel("Tu nombre para el equipo").fill("invitation-host");
  await admin.getByLabel("Nombre del primer proyecto").fill("Equipo sin comandos");
  await admin.screenshot({ path: info.outputPath("first-workspace-desktop.png"), fullPage: true });
  await admin.setViewportSize({ width: 375, height: 812 });
  await admin.emulateMedia({ reducedMotion: "reduce" });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: info.outputPath("first-workspace-mobile.png"), fullPage: true });
  await admin.getByRole("button", { name: "Preparar proyecto", exact: true }).focus();
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("status")).toContainText("Proyecto preparado");
  await expect(admin.getByRole("button", { name: "Iniciar Hub", exact: true })).toBeFocused();
  await expect(admin.getByRole("heading", { name: "Prepara tu primer proyecto" })).toHaveCount(0);
  await expect(admin.getByLabel("Credencial emitida")).toHaveCount(0);
  const initial = await (await admin.request.get(`${local}/local-api/snapshot`)).json();
  expect(initial.accesses).toHaveLength(0);
  await expect(admin.getByRole("button", { name: "Crear invitación", exact: true })).toBeDisabled();
  await admin.getByRole("button", { name: "Iniciar Hub", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("Hub iniciado");
  await admin.getByLabel("Nombre de la persona nueva").fill("new-friend");
  await admin.getByLabel("Permisos de la invitación").selectOption("collaborator");
  await admin.getByRole("button", { name: "Crear invitación", exact: true }).focus();
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("status")).toContainText("Invitación al portal creada");
  const secretField = admin.getByLabel("Enlace de entrada");
  await expect(secretField).toHaveAttribute("type", "password");
  const link = await secretField.inputValue();
  const proof = new URLSearchParams(new URL(link).hash.slice(1)).get("entry") as string;
  const snapshot = await (await admin.request.get(`${local}/local-api/snapshot`)).json();
  const friend = snapshot.users.find((u: { username: string }) => u.username === "new-friend");
  expect(friend).toBeTruthy();
  expect(
    snapshot.accesses.filter((a: { subject: string }) => a.subject === friend.user_id),
  ).toHaveLength(0);
  const project = snapshot.projects[0].project_id;
  // Inspect membership using an independent human owner cookie, never an MCP token.
  const owner = snapshot.users.find((u: { username: string }) => u.username === "invitation-host");
  const ownerEntry = await (
    await admin.request.post(`${local}/local-api/users/${owner.user_id}/web-entry`, {
      headers: { origin: local },
      data: { project_id: project },
    })
  ).json();
  expect(
    (
      await request.post(`${portal}/v1/web/entry`, {
        headers: { origin: portal },
        data: { secret: ownerEntry.secret },
      })
    ).status(),
  ).toBe(200);
  const members = async () =>
    (
      await (
        await request.get(`${portal}/v1/projects/${project}/members`, {
          headers: { origin: portal },
        })
      ).json()
    ).data;
  expect(
    (await members()).filter((m: { user_id: string }) => m.user_id === friend.user_id),
  ).toHaveLength(0);
  await admin.setViewportSize({ width: 375, height: 812 });
  await admin.emulateMedia({ reducedMotion: "reduce" });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: info.outputPath("invitation-panel-mobile.png"), fullPage: true });
  await admin.setViewportSize({ width: 1280, height: 900 });
  await admin.screenshot({ path: info.outputPath("invitation-panel-desktop.png"), fullPage: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const authHeaders: string[] = [];
  const proofLeaks: boolean[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/v1/")) authHeaders.push(req.headers().authorization ?? "");
    proofLeaks.push(req.url().includes(proof));
  });
  try {
    await page.goto(link);
    await expect(page.getByRole("region", { name: "Identidad de entrada" })).toContainText(
      "new-friend",
    );
    expect(page.url()).not.toContain("#");
    expect(
      (await context.cookies(`${portal}/v1/`)).filter((c) => c.name === "ah_web"),
    ).toHaveLength(0);
    expect(
      (await members()).filter((m: { user_id: string }) => m.user_id === friend.user_id),
    ).toHaveLength(0);
    await page.screenshot({
      path: info.outputPath("new-person-preview-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Entrar al proyecto", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Conectado (WS)", { exact: true })).toBeVisible();
    expect(
      (await members()).find((m: { user_id: string }) => m.user_id === friend.user_id).role,
    ).toBe("collaborator");
    await page
      .getByPlaceholder("Escribe un mensaje para coordinar con el equipo...")
      .fill("Entré sólo con una invitación");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByText("Entré sólo con una invitación", { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByText("Conectado (WS)", { exact: true })).toBeVisible();
    await expect(page.getByText("Entré sólo con una invitación", { exact: true })).toHaveCount(1);
    expect(authHeaders.every((value) => !value)).toBe(true);
    expect(proofLeaks.some(Boolean)).toBe(false);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).toBe(
      "[{},{}]",
    );
    await admin.getByRole("button", { name: "Actualizar estado", exact: true }).click();
    await expect(admin.getByRole("status")).toContainText("Estado actualizado");
    const row = admin.getByRole("listitem").filter({ hasText: "new-friend" });
    await expect(row).toContainText("Aceptada");
    await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Ingresar al Dashboard", exact: true }),
    ).toBeVisible();
    expect(
      (await context.cookies(`${portal}/v1/`)).filter((c) => c.name === "ah_web"),
    ).toHaveLength(0);
    await admin.getByRole("button", { name: "Descartar de pantalla" }).click();
    await admin.getByLabel("Nombre de la persona nueva").fill("revoked-friend");
    await admin.getByRole("button", { name: "Crear invitación", exact: true }).click();
    await expect(admin.getByRole("status")).toContainText("Invitación al portal creada");
    const revokedLink = await secretField.inputValue();
    await admin
      .getByRole("button", { name: "Revocar invitación de revoked-friend", exact: true })
      .click();
    await admin.getByRole("button", { name: "Cancelar revocación de invitación" }).click();
    await admin
      .getByRole("button", { name: "Revocar invitación de revoked-friend", exact: true })
      .click();
    await admin.getByRole("button", { name: "Confirmar revocación de invitación" }).click();
    await expect(admin.getByRole("status")).toContainText("Invitación al portal revocada");
    await expect(secretField).toHaveCount(0);
    await expect(admin.getByRole("listitem").filter({ hasText: "revoked-friend" })).toContainText(
      "Revocada",
    );
    await page.goto(revokedLink);
    await expect(page.getByRole("alert")).toContainText("venció");
    await admin.getByLabel("Persona a invitar", { exact: true }).selectOption("existing");
    await admin
      .getByLabel("Persona existente", { exact: true })
      .selectOption({ label: "revoked-friend" });
    await admin.getByRole("button", { name: "Crear invitación", exact: true }).click();
    await expect(admin.getByRole("status")).toContainText("Invitación al portal creada");
    await page.goto(await secretField.inputValue());
    await expect(page.getByRole("region", { name: "Identidad de entrada" })).toContainText(
      "revoked-friend",
    );
    await admin.getByLabel("Persona a invitar", { exact: true }).selectOption("new");
    await admin.getByLabel("Nombre de la persona nueva").fill("new-friend");
    await admin.getByRole("button", { name: "Crear invitación", exact: true }).click();
    await expect(admin.getByRole("alert")).toContainText("ya existe");
  } finally {
    await context.close();
  }
});
