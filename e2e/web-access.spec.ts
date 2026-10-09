import { type ChildProcess, fork } from "node:child_process";
import { expect, test } from "@playwright/test";

let child: ChildProcess;
let localEntry = "";
const portal = "http://127.0.0.1:8797";
test.beforeAll(async () => {
  child = fork("apps/hub-server/dist/companion.js", [], {
    env: {
      ...process.env,
      DATABASE_URL: ":memory:",
      PORT: "8797",
      LOCAL_CONTROL_PORT: "8796",
      AGENTS_HUB_NO_BROWSER: "1",
      LOG_LEVEL: "fatal",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  localEntry = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Companion readiness timeout")), 15000);
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

test("entrada gráfica confirma identidad, reanuda por cookie y cierra sólo la sesión humana", async ({
  page: admin,
  browser,
  request,
}, info) => {
  await admin.goto(localEntry);
  await admin.getByLabel("Nombre de usuario").fill("portal-host");
  await admin.getByRole("button", { name: "Crear persona", exact: true }).click();
  await expect(admin.getByLabel("Credencial emitida")).toBeVisible();
  const personal = await admin.getByLabel("Credencial emitida").inputValue();
  await admin.getByRole("button", { name: "Descartar de pantalla" }).click();
  await admin.getByRole("button", { name: "Proyectos e invitaciones", exact: true }).click();
  await admin.getByLabel("Nombre del proyecto").fill("Proyecto de entrada gráfica");
  await admin.getByRole("button", { name: "Crear proyecto", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("Proyecto creado");
  await admin.getByRole("button", { name: "Iniciar Hub", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("Hub iniciado");
  await admin.getByRole("button", { name: "Personas", exact: true }).click();
  const createEntry = async () => {
    await admin.getByRole("button", { name: "Crear entrada al portal", exact: true }).click();
    await expect(admin.getByRole("status")).toContainText("Entrada creada");
    const input = admin.getByLabel("Enlace de entrada");
    await expect(input).toHaveAttribute("type", "password");
    return input.inputValue();
  };
  const link = await createEntry();
  await admin.screenshot({ path: info.outputPath("panel-entry-desktop.png"), fullPage: true });
  await admin.setViewportSize({ width: 375, height: 812 });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await admin.screenshot({ path: info.outputPath("panel-entry-mobile.png"), fullPage: true });
  const proof = new URLSearchParams(new URL(link).hash.slice(1)).get("entry");
  expect(proof).toBeTruthy();
  const context = await browser.newContext();
  const page = await context.newPage();
  const authorizations: string[] = [];
  const leakedProofs: boolean[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/v1/")) authorizations.push(req.headers().authorization ?? "");
    leakedProofs.push(req.url().includes(proof as string));
  });
  try {
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Entra a tu proyecto" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Identidad de entrada" })).toContainText(
      "portal-host",
    );
    expect(page.url()).not.toContain("#");
    expect(
      (await context.cookies(`${portal}/v1/`)).filter((c) => c.name === "ah_web"),
    ).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("entry-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("entry-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Entrar al proyecto", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Conversación del equipo" })).toBeVisible();
    await expect(page.getByText("Conectado (WS)", { exact: true })).toBeVisible();
    const cookies = (await context.cookies(`${portal}/v1/`)).filter((c) => c.name === "ah_web");
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/v1/" });
    expect(await page.evaluate(() => document.cookie)).not.toContain("ah_web");
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).toBe(
      "[{},{}]",
    );
    await page
      .getByPlaceholder("Escribe un mensaje para coordinar con el equipo...")
      .fill("Entrada sin IDs ni tokens manuales");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByText("Entrada sin IDs ni tokens manuales", { exact: true })).toHaveCount(
      1,
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Conversación del equipo" })).toBeVisible();
    await expect(page.getByText("Conectado (WS)", { exact: true })).toBeVisible();
    await expect(page.getByText("Entrada sin IDs ni tokens manuales", { exact: true })).toHaveCount(
      1,
    );
    expect(authorizations.every((value) => !value)).toBe(true);
    expect(leakedProofs.some(Boolean)).toBe(false);
    expect(
      (
        await request.post(`${portal}/v1/web/entry`, {
          headers: { origin: portal },
          data: { secret: proof },
        })
      ).status(),
    ).toBe(401);

    // Cancellation neither consumes the new entry nor changes an existing browser identity.
    const nextLink = await createEntry();
    await expect(admin.getByText("Sesión del portal", { exact: true })).toBeVisible();
    await expect(admin.getByText("Acceso de agente / personal", { exact: true })).toBeVisible();
    const cookieBefore = (await context.cookies(`${portal}/v1/`)).find(
      (c) => c.name === "ah_web",
    )?.value;
    await page.goto(nextLink);
    await expect(page.getByText(/Tienes una sesión como portal-host/)).toBeVisible();
    await page.screenshot({
      path: info.outputPath("entry-current-session-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    expect(
      (await context.cookies(`${portal}/v1/`)).find((c) => c.name === "ah_web")?.value ===
        cookieBefore,
    ).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Conversación del equipo" })).toBeVisible();
    const unused = new URLSearchParams(new URL(nextLink).hash.slice(1)).get("entry");
    expect(
      (
        await request.post(`${portal}/v1/web/entry/preview`, {
          headers: { origin: portal },
          data: { secret: unused },
        })
      ).status(),
    ).toBe(200);

    await page.route("**/v1/web/logout", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Cierre temporalmente no disponible" },
        }),
      }),
    );
    await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Cierre temporalmente no disponible" }),
    ).toBeVisible();
    expect((await context.cookies(`${portal}/v1/`)).some((c) => c.name === "ah_web")).toBe(true);
    await page.unroute("**/v1/web/logout");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Conversación del equipo" })).toBeVisible();
    await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Entra a tu proyecto" })).not.toBeVisible();
    await expect(page.getByLabel("Token de acceso")).toBeVisible();
    expect(
      (await context.cookies(`${portal}/v1/`)).filter((c) => c.name === "ah_web"),
    ).toHaveLength(0);
    await page.reload();
    await expect(page.getByLabel("Token de acceso")).toBeVisible();
    expect(
      (
        await request.get(`${portal}/v1/web/session`, {
          headers: { host: "127.0.0.1:8797", cookie: `ah_web=${cookieBefore}` },
        })
      ).status(),
    ).toBe(401);
    const snapshot = await admin.evaluate(
      async () => await (await fetch("/local-api/snapshot")).json(),
    );
    const project = snapshot.projects.find(
      (p: { name: string }) => p.name === "Proyecto de entrada gráfica",
    ).project_id;
    expect(
      (
        await request.get(`${portal}/v1/projects/${project}`, {
          headers: { authorization: `Bearer ${personal}` },
        })
      ).status(),
    ).toBe(200);
    expect((await request.get(`${portal}/local-api/snapshot`)).status()).toBe(404);
    await page.goto(link);
    await expect(page.getByRole("alert")).toContainText(/venció|utilizada|válida/);
    await page.screenshot({ path: info.outputPath("entry-invalid-mobile.png"), fullPage: true });

    // Switching identities must not expose the previous owner's cached invitations.
    await page.goto(nextLink);
    await page.getByRole("button", { name: "Entrar al proyecto", exact: true }).click();
    await expect(page.getByText("Conectado (WS)", { exact: true })).toBeVisible();
    await page.getByTestId("tab-members").click();
    await page.getByLabel("Rol de invitación").selectOption("reader");
    await page.getByRole("button", { name: "Crear invitación", exact: true }).click();
    const inviteInput = page.getByLabel("Invitación recién creada (compártela por privado)");
    await expect(inviteInput).toBeVisible();
    const invitation = await inviteInput.inputValue();
    await expect(page.locator(".invitation-row").first()).toBeVisible();
    await admin.getByLabel("Nombre de usuario").fill("portal-reader");
    await admin.getByRole("button", { name: "Crear persona", exact: true }).click();
    await expect(
      admin.getByRole("heading", { name: "Acceso de portal-reader", exact: true }),
    ).toBeVisible();
    const readerToken = await admin.getByLabel("Credencial emitida").inputValue();
    expect(
      (
        await request.post(`${portal}/v1/projects/${project}/invitations/accept`, {
          headers: { authorization: `Bearer ${readerToken}` },
          data: { token: invitation },
        })
      ).status(),
    ).toBe(200);
    const readerLink = await createEntry();
    const ownerCookie = (await context.cookies(`${portal}/v1/`)).find(
      (c) => c.name === "ah_web",
    )?.value;
    await page.goto(readerLink);
    await expect(page.getByRole("region", { name: "Identidad de entrada" })).toContainText(
      "portal-reader",
    );
    await expect(page.getByText(/Tienes una sesión como portal-host/)).toBeVisible();
    let requested = false;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${portal}/v1/projects/${project}/invitations`, async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "FORBIDDEN", message: "Sólo administradores pueden ver invitaciones" },
        }),
      });
    });
    try {
      await page.getByRole("button", { name: "Entrar al proyecto", exact: true }).click();
      await expect(page.getByText("Conectado (WS)", { exact: true })).toBeVisible();
      await page.getByTestId("tab-members").click();
      await expect.poll(() => requested).toBe(true);
      await expect(page.locator(".invitation-row")).toHaveCount(0);
      await expect(inviteInput).not.toBeVisible();
      expect(
        (
          await request.get(`${portal}/v1/web/session`, {
            headers: { cookie: `ah_web=${ownerCookie}` },
          })
        ).status(),
      ).toBe(401);
    } finally {
      release?.();
    }
    await expect(
      page.getByRole("button", { name: "Crear invitación", exact: true }),
    ).not.toBeVisible();
    await page.unroute(`${portal}/v1/projects/${project}/invitations`);
    await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(page.getByLabel("Token de acceso")).toBeVisible();
  } finally {
    await context.close();
  }
});
