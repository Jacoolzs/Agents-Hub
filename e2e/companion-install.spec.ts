import { type ChildProcess, execFile, fork } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

test("packaged panel installs native shortcuts and reopens the installed copy with preserved data", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!process.env.AGENTS_HUB_PORTABLE_ARTIFACT, "Portable preview not built");
  test.setTimeout(90000);
  const source = path.resolve(process.env.AGENTS_HUB_PORTABLE_ARTIFACT as string);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ah-install-ui-"));
  const profile = path.join(temporary, "profile & spaces");
  const data = path.join(temporary, "private data");
  const menu = path.join(profile, "menu");
  const desktop = path.join(profile, "desktop");
  const env = {
    ...process.env,
    LOCALAPPDATA: profile,
    XDG_DATA_HOME: profile,
    AGENTS_HUB_MENU_DIR: menu,
    AGENTS_HUB_DESKTOP_DIR: desktop,
    AGENTS_HUB_DATA_DIR: data,
    DATABASE_URL: path.join(data, "install.sqlite"),
    PORT: "8816",
    LOCAL_CONTROL_PORT: "8817",
    AGENTS_HUB_NO_BROWSER: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    LOG_LEVEL: "fatal",
  };
  let child: ChildProcess | undefined;
  async function launch(script: string, node: string) {
    const own = fork(script, [], {
      execPath: node,
      cwd: temporary,
      env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    child = own;
    const entry = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Installed companion not ready")), 15000);
      own.once("error", reject);
      own.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Companion exited before ready"));
      });
      own.once("message", (message) => {
        clearTimeout(timer);
        if (
          !message ||
          typeof message !== "object" ||
          !("url" in message) ||
          typeof message.url !== "string"
        )
          return reject(new Error("Invalid readiness"));
        resolve(message.url);
      });
    });
    await page.goto(entry);
    await expect(
      page.getByRole("heading", { name: "Instalar en este PC", exact: true }),
    ).toBeVisible();
  }
  async function close() {
    await page.getByRole("button", { name: "Cerrar Agents-Hub", exact: true }).click();
    await page.getByRole("button", { name: "Confirmar cierre de Agents-Hub" }).click();
    await expect.poll(() => child?.exitCode, { timeout: 5000 }).toBe(0);
  }
  try {
    await mkdir(profile);
    await launch(
      path.join(source, "scripts/launch.mjs"),
      path.join(source, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    );
    await page.getByLabel("Tu nombre para el equipo").fill("installed-owner");
    await page.getByLabel("Nombre del primer proyecto").fill("Installed persistent team");
    await page.getByRole("button", { name: "Preparar proyecto" }).click();
    await expect(page.getByRole("status")).toContainText("Proyecto preparado");
    await page.getByRole("button", { name: "Iniciar Hub", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Hub iniciado");
    const review = page.getByRole("button", { name: "Revisar instalación" });
    await review.click();
    await expect(page.getByRole("button", { name: "Cancelar instalación" })).toBeFocused();
    await page.getByRole("button", { name: "Cancelar instalación" }).press("Enter");
    await expect(review).toBeFocused();
    await expect(access(menu)).rejects.toThrow();
    await review.click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByLabel("Crear también un acceso en el escritorio").check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("installation-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Confirmar instalación y accesos" }).press("Enter");
    await expect(
      page.getByRole("heading", { name: "Agents-Hub instalado en este PC" }),
    ).toBeFocused({ timeout: 60000 });
    expect((await request.get("http://127.0.0.1:8816/health/live")).status()).toBe(200);
    const files = await readdir(menu);
    expect(files).toHaveLength(1);
    expect(await readdir(desktop)).toEqual(files);
    let node: string;
    let script: string;
    if (process.platform === "win32") {
      const result = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:AH_TEST_LINK); @{node=$s.TargetPath;script=$s.Arguments} | ConvertTo-Json -Compress",
        ],
        {
          env: { ...env, AH_TEST_LINK: path.join(menu, files[0]) },
          windowsHide: true,
          timeout: 10000,
        },
      );
      const shortcut = JSON.parse(result.stdout.trim());
      node = shortcut.node;
      script = shortcut.script.slice(1, -1);
    } else {
      const base = path.join(profile, "agents-hub-program");
      const [version] = await readdir(path.join(base, "versions"));
      const [identity] = await readdir(path.join(base, "entries"));
      node = path.join(base, "versions", version, "runtime/node");
      script = path.join(base, "entries", identity, "open.mjs");
      expect(await readFile(path.join(menu, files[0]), "utf8")).toContain(
        `Exec="${node}" "${script}"`,
      );
    }
    expect(node.startsWith(profile)).toBe(true);
    expect(await readFile(script, "utf8")).not.toMatch(/local-control|TOKEN|secret/);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({
      path: testInfo.outputPath("installation-desktop.png"),
      fullPage: true,
    });
    await close();
    await launch(script, node);
    await expect(
      page.getByText("Ya hay una copia de esta versión.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Proyectos e invitaciones", exact: true }).click();
    await expect(
      page.getByRole("listitem").getByText("Installed persistent team", { exact: true }),
    ).toBeVisible();
    await review.click();
    await page.getByRole("button", { name: "Confirmar instalación y accesos" }).click();
    await expect(
      page.getByRole("heading", { name: "Agents-Hub instalado en este PC" }),
    ).toBeVisible({ timeout: 60000 });
    expect(await readdir(menu)).toEqual(files);
    await close();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      if (child.connected) child.send({ type: "shutdown" });
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    if (
      path.dirname(temporary) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("ah-install-ui-")
    )
      await rm(temporary, { recursive: true, force: true });
  }
});
