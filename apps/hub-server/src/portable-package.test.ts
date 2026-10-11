import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  outputDirectory,
  runtimeArchives,
  runtimeVersion,
  verifiedRuntime,
} from "../../../scripts/package-companion.mjs";
import { portableData } from "../../../scripts/portable/launch.mjs";

describe("portable package boundaries", () => {
  it("pins the runtime and refuses modified downloads before extraction", () => {
    expect(runtimeVersion).toBe("24.21.0");
    for (const archive of Object.values(runtimeArchives))
      expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    const bytes = Buffer.from("test runtime");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    expect(() => verifiedRuntime(bytes, checksum)).not.toThrow();
    expect(() => verifiedRuntime(Buffer.from("changed"), checksum)).toThrow("checksum mismatch");
  });
  it("keeps per-user data outside resources and preserves explicit overrides", () => {
    const base = path.join(os.tmpdir(), "portable user");
    expect(portableData({ LOCALAPPDATA: base }, "win32")).toBe(path.join(base, "Agents-Hub"));
    expect(portableData({ XDG_DATA_HOME: base }, "linux")).toBe(path.join(base, "agents-hub"));
    expect(portableData({}, "linux", base)).toBe(path.join(base, ".local/share/agents-hub"));
    expect(portableData({ AGENTS_HUB_DATA_DIR: base }, "win32")).toBe(base);
    expect(() => portableData({}, "win32")).toThrow();
    expect(() => portableData({ AGENTS_HUB_DATA_DIR: "relative" })).toThrow();
    expect(() => portableData({ XDG_DATA_HOME: "relative" }, "linux")).toThrow();
  });
  it("rejects broad or ambiguous producer destinations", () => {
    for (const value of [
      undefined,
      "relative",
      path.parse(process.cwd()).root,
      os.homedir(),
      fileURLToPath(new URL("../../../", import.meta.url)),
    ])
      expect(() => outputDirectory(value)).toThrow();
    expect(outputDirectory(path.join(os.tmpdir(), "new package"))).toBe(
      path.join(os.tmpdir(), "new package"),
    );
  });
});
