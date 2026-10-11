import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createInstallation } from "../../../scripts/portable/install-ui.mjs";
import { installPackage, installationRoot } from "../../../scripts/portable/install.mjs";
import { desktopEntry } from "../../../scripts/portable/shortcuts.mjs";

async function fixture(task: (source: string, base: string, data: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ah-install-test-"));
  const source = path.join(temporary, "package with spaces");
  const base = path.join(temporary, "program resources");
  const data = path.join(temporary, "private data");
  try {
    const files = [];
    for (const file of [
      "scripts/launch.mjs",
      "apps/web/dist/index.html",
      "apps/hub-server/dist/companion.js",
      "packages/mcp-server/dist/main.js",
      process.platform === "win32" ? "runtime/node.exe" : "runtime/node",
    ]) {
      const bytes = Buffer.from(`fixture ${file}`);
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), bytes);
      files.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await writeFile(
      path.join(source, "artifact.json"),
      JSON.stringify({
        format: 1,
        preview: true,
        platform: process.platform,
        arch: process.arch,
        files,
      }),
    );
    await mkdir(data);
    await writeFile(path.join(data, "preserved.sqlite"), "not a real database");
    await task(source, base, data);
  } finally {
    if (
      path.dirname(temporary) === path.resolve(os.tmpdir()) &&
      path.basename(temporary).startsWith("ah-install-test-")
    )
      await rm(temporary, { recursive: true, force: true });
  }
}

describe("versioned per-user installation", () => {
  it(
    "confirms installation, reuses verified copies and preserves foreign shortcuts",
    async () =>
      fixture(async (source, _base, data) => {
        let profileParent = path.dirname(data);
        if (process.platform === "win32") {
          const alias = await promisify(execFile)(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:AH_TEST_PARENT).ShortPath",
            ],
            {
              env: { ...process.env, AH_TEST_PARENT: profileParent },
              windowsHide: true,
              timeout: 10000,
            },
          );
          profileParent = alias.stdout.trim();
        }
        const profile = path.join(profileParent, "profile & spaces");
        const env = {
          LOCALAPPDATA: profile,
          XDG_DATA_HOME: profile,
          AGENTS_HUB_MENU_DIR: path.join(profile, "menu"),
          AGENTS_HUB_DESKTOP_DIR: path.join(profile, "desktop"),
        };
        const launch = {
          AGENTS_HUB_DATA_DIR: data,
          DATABASE_URL: path.join(data, "agents-hub.sqlite"),
          PORT: "8816",
          LOCAL_CONTROL_PORT: "8817",
        };
        const installer = createInstallation(source, launch, env);
        expect((await installer.describe()).state).toBe("ready");
        await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
        const first = await installer.install(false);
        expect(first.shortcuts).toHaveLength(1);
        expect((await installer.describe()).state).toBe("installed");
        const second = await installer.install(true);
        expect(second.destination).toBe(first.destination);
        expect(second.shortcuts).toHaveLength(2);
        const fromInstalled = createInstallation(first.destination, launch, env);
        expect((await fromInstalled.install(false)).destination).toBe(first.destination);
        await writeFile(first.shortcuts[0], "foreign shortcut");
        await expect(installer.install(false)).rejects.toThrow();
        expect(await readFile(first.shortcuts[0], "utf8")).toBe("foreign shortcut");
        expect(await readFile(path.join(data, "preserved.sqlite"), "utf8")).toBe(
          "not a real database",
        );
        await writeFile(path.join(first.destination, "scripts/launch.mjs"), "damaged");
        await expect(installer.install(false)).rejects.toThrow("alterado");
      }),
    30000,
  );
  it("recognizes but does not replace a partial copy", async () =>
    fixture(async (source, _base, data) => {
      const profile = path.join(path.dirname(data), "profile");
      const env = { LOCALAPPDATA: profile, XDG_DATA_HOME: profile };
      const installer = createInstallation(source, { AGENTS_HUB_DATA_DIR: data }, env);
      const plan = await installer.describe();
      await mkdir(plan.destination, { recursive: true });
      await writeFile(path.join(plan.destination, "keep.txt"), "partial data");
      expect((await installer.describe()).state).toBe("partial");
      await expect(installer.install(false)).rejects.toThrow("incompleta");
      expect(await readdir(plan.destination)).toEqual(["keep.txt"]);
    }));
  it("quotes desktop paths without shell expansion and escapes literal field codes", () => {
    const node = path.join(os.tmpdir(), "runtime with spaces", "node");
    const entry = path.join(os.tmpdir(), "entry $cash %f `tick`", "open.mjs");
    const text = desktopEntry(node, entry, "Agents-Hub");
    expect(text).toContain("%%f");
    expect(text).toContain("\\\\$cash");
    expect(text).toContain("\\\\`tick\\\\`");
    expect(text).toContain("Terminal=true");
    expect(() => desktopEntry("relative", entry, "Agents-Hub")).toThrow();
  });
  it("separates default resources from user data and rejects ambiguous bases", () => {
    const user = path.join(os.tmpdir(), "fake user");
    expect(installationRoot({ LOCALAPPDATA: user }, "win32")).toBe(
      path.join(user, "Programs/Agents-Hub"),
    );
    expect(installationRoot({ XDG_DATA_HOME: user }, "linux")).toBe(
      path.join(user, "agents-hub-program"),
    );
    expect(installationRoot({}, "linux", user)).toBe(
      path.join(user, ".local/share/agents-hub-program"),
    );
    expect(() => installationRoot({}, "win32")).toThrow();
    expect(() => installationRoot({ XDG_DATA_HOME: "relative" }, "linux")).toThrow();
  });
  it("installs complete immutable versions while preserving data and earlier versions", async () =>
    fixture(async (source, base, data) => {
      const installed = await installPackage(source, base, data);
      expect(path.dirname(installed)).toBe(path.join(base, "versions"));
      expect(path.basename(installed)).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(await readFile(path.join(installed, "installation.json"), "utf8"))).toEqual(
        { format: 1, artifactSha256: path.basename(installed) },
      );
      await expect(installPackage(source, base, data)).rejects.toMatchObject({ code: "EEXIST" });
      const manifest = JSON.parse(await readFile(path.join(source, "artifact.json"), "utf8"));
      manifest.buildLabel = "another preview";
      await writeFile(path.join(source, "artifact.json"), JSON.stringify(manifest));
      const next = await installPackage(source, base, data);
      expect(next).not.toBe(installed);
      expect(await readdir(path.join(base, "versions"))).toHaveLength(2);
      expect(await readFile(path.join(data, "preserved.sqlite"), "utf8")).toBe(
        "not a real database",
      );
    }));
  it("rejects tampered or extra files before creating a destination", async () =>
    fixture(async (source, base, data) => {
      await writeFile(path.join(source, "unexpected.txt"), "extra");
      await expect(installPackage(source, base, data)).rejects.toThrow("inventario");
      await rm(path.join(source, "unexpected.txt"));
      await writeFile(path.join(source, "scripts/launch.mjs"), "tampered");
      await expect(installPackage(source, base, data)).rejects.toThrow("alterado");
      await expect(access(base)).rejects.toMatchObject({ code: "ENOENT" });
    }));
  it("rejects traversal, aliases, reserved files and incompatible manifests", async () =>
    fixture(async (source, base, data) => {
      const original = JSON.parse(await readFile(path.join(source, "artifact.json"), "utf8"));
      for (const value of [
        "../escape",
        "/absolute",
        "C:/escape",
        "scripts\\escape",
        "CON",
        "a:stream",
        "scripts/LAUNCH.mjs",
        "installation.json",
      ]) {
        const manifest = structuredClone(original);
        manifest.files.push({ path: value, sha256: "0".repeat(64) });
        await writeFile(path.join(source, "artifact.json"), JSON.stringify(manifest));
        await expect(installPackage(source, base, data)).rejects.toThrow();
      }
      await writeFile(
        path.join(source, "artifact.json"),
        JSON.stringify({ ...original, arch: "unsupported" }),
      );
      await expect(installPackage(source, base, data)).rejects.toThrow("incompatible");
      await expect(access(base)).rejects.toMatchObject({ code: "ENOENT" });
    }));
  it("rejects broad, source and data-overlapping destinations", async () =>
    fixture(async (source, base, data) => {
      for (const target of [
        "relative",
        path.parse(base).root,
        os.homedir(),
        source,
        path.join(source, "nested"),
        data,
        path.join(data, "nested"),
        path.dirname(data),
      ])
        await expect(installPackage(source, target, data)).rejects.toThrow();
      expect(await readFile(path.join(data, "preserved.sqlite"), "utf8")).toBe(
        "not a real database",
      );
    }));
  it("rejects directory links in source, target and data without touching their targets", async () =>
    fixture(async (source, base, data) => {
      const linked = path.join(path.dirname(base), "link");
      await symlink(data, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(installPackage(source, path.join(linked, "program"), data)).rejects.toThrow(
        "enlace",
      );
      await expect(installPackage(source, base, linked)).rejects.toThrow("enlace");
      await expect(installPackage(linked, base, data)).rejects.toThrow("enlace");
      expect(await readdir(data)).toEqual(["preserved.sqlite"]);
    }));
  it("allows only one concurrent installer for the same version", async () =>
    fixture(async (source, base, data) => {
      const results = await Promise.allSettled([
        installPackage(source, base, data),
        installPackage(source, base, data),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await readdir(path.join(base, "versions"))).toHaveLength(1);
    }));
});
