import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createMcpConfig } from "../../../scripts/mcp-config.mjs";

describe("MCP configuration templates", () => {
  it("exports only a local reference and agent name without reading a vault", () => {
    const file = path.join(tmpdir(), "nonexistent-profile", `${crypto.randomUUID()}.json`);
    const config = createMcpConfig({ connectionFile: file, agentName: "local-agent" }).mcpServers[
      "agents-hub"
    ];
    expect(config.env).toEqual({
      AGENTS_HUB_CONNECTION_FILE: file,
      AGENTS_HUB_AGENT_NAME: "local-agent",
    });
    expect(path.isAbsolute(config.command)).toBe(true);
    expect(path.isAbsolute(config.args[0])).toBe(true);
    expect(() =>
      createMcpConfig({ connectionFile: file, hubUrl: "https://example.test" }),
    ).toThrow();
    expect(() =>
      createMcpConfig({ connectionFile: file, projectId: crypto.randomUUID() }),
    ).toThrow();
    expect(() => createMcpConfig({ connectionFile: "relative.json" })).toThrow();
    expect(() =>
      createMcpConfig({ connectionFile: file, agentName: "ahd_PRIVATE_INPUT_CREDENTIAL" }),
    ).toThrow();
    expect(() =>
      createMcpConfig({ connectionFile: file, agentName: "ahp_PRIVATE_REVIEW_PROOF" }),
    ).toThrow();
  });
  it("produces absolute launch paths and a placeholder instead of the real environment credential", async () => {
    const token = "ah_PRIVATE_ENVIRONMENT_CREDENTIAL";
    const project = crypto.randomUUID();
    const result = await promisify(execFile)(
      process.execPath,
      [
        path.resolve("scripts/mcp-config.mjs"),
        "--agent-name",
        "my-agent",
        "--hub-url",
        "https://hub.example.test",
        "--project-id",
        project,
      ],
      { env: { ...process.env, AGENTS_HUB_TOKEN: token } },
    );
    const config = JSON.parse(result.stdout).mcpServers["agents-hub"];
    expect(path.isAbsolute(config.command)).toBe(true);
    expect(path.isAbsolute(config.args[0])).toBe(true);
    expect(config.env.AGENTS_HUB_AGENT_NAME).toBe("my-agent");
    expect(config.env.AGENTS_HUB_PROJECT_ID).toBe(project);
    expect(config.env.AGENTS_HUB_TOKEN).toBe("TU_TOKEN_PERSONAL");
    expect(result.stdout).not.toContain(token);
  });

  it("creates a new file and refuses to overwrite the existing configuration", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agents-hub-config-"));
    try {
      const file = path.join(directory, "client.json");
      const run = promisify(execFile);
      const command = [
        path.resolve("scripts/mcp-config.mjs"),
        "--agent-name",
        "first-agent",
        "--output",
        file,
      ];
      await run(process.execPath, command);
      const before = readFileSync(file, "utf8");
      expect(JSON.parse(before).mcpServers["agents-hub"].env.AGENTS_HUB_AGENT_NAME).toBe(
        "first-agent",
      );
      await expect(
        run(process.execPath, [
          path.resolve("scripts/mcp-config.mjs"),
          "--agent-name",
          "second-agent",
          "--output",
          file,
        ]),
      ).rejects.toMatchObject({ code: 1 });
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe URL and credential-shaped input without echoing the credential", async () => {
    const token = "ah_PRIVATE_INPUT_CREDENTIAL";
    expect(() => createMcpConfig({ hubUrl: `https://user:${token}@example.test` })).toThrow();
    expect(() => createMcpConfig({ hubUrl: "http://remote.example.test" })).toThrow();
    await expect(
      promisify(execFile)(process.execPath, [
        path.resolve("scripts/mcp-config.mjs"),
        "--agent-name",
        token,
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining(token) });
  });
});
