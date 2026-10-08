import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../../scripts/doctor.mjs";
import { buildApp } from "./app.js";

describe("Read-only onboarding doctor", () => {
  it("reports a connection failure without claiming that an unseen Hub is incompatible", async () => {
    const result = await runDoctor({
      env: { AGENTS_HUB_URL: "https://unreachable.example.test" },
      runtimeVersion: "24.12.0",
      fetchImpl: async () => {
        throw new Error("Connection failed");
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check: { name: string }) => check.name === "compatibility")?.code,
    ).toBe("UNREACHABLE");
    expect(JSON.stringify(result)).not.toContain("HUB_INCOMPATIBLE");
  });
  it("checks a real Hub, identity and membership without mutating collaboration data", async () => {
    const app = buildApp();
    try {
      const owner = crypto.randomUUID();
      const project = app.ctx.projectService.createProject("Doctor", owner).project.project_id;
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      await app.listen({ host: "127.0.0.1", port: 0 });
      const snapshot = () =>
        Object.fromEntries(
          [
            "events",
            "agent_sessions",
            "messages",
            "workspace_locks",
            "audit_entries",
            "idempotency_records",
          ].map((table) => [
            table,
            app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
          ]),
        );
      const before = snapshot();
      const methods: string[] = [];
      const env = {
        AGENTS_HUB_URL: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
        AGENTS_HUB_TOKEN: token,
        AGENTS_HUB_PROJECT_ID: project,
      };
      const result = await runDoctor({
        env,
        runtimeVersion: "24.12.0",
        fetchImpl: (url: string, options: RequestInit) => {
          methods.push(options.method ?? "GET");
          expect(options.redirect).toBe("error");
          return fetch(url, options);
        },
      });
      expect(result.ok).toBe(true);
      expect(result.checks.map((check: { name: string }) => check.name)).toEqual([
        "runtime",
        "build",
        "url",
        "readiness",
        "compatibility",
        "identity",
        "membership",
      ]);
      expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
      expect(snapshot()).toEqual(before);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(owner);
      const cli = await promisify(execFile)(
        process.execPath,
        [path.resolve("scripts/doctor.mjs"), "--json"],
        { env: { ...process.env, ...env } },
      );
      expect(JSON.parse(cli.stdout).ok).toBe(true);
      expect(cli.stdout).not.toContain(token);
      expect(snapshot()).toEqual(before);
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("provides useful errors for revoked identity and missing membership without exposing token data", async () => {
    const app = buildApp();
    try {
      const owner = crypto.randomUUID();
      const project = app.ctx.projectService.createProject("Doctor access", owner).project
        .project_id;
      const token = app.ctx.authService.createToken(owner, "agents-hub");
      const outsider = app.ctx.authService.createToken(crypto.randomUUID(), "agents-hub");
      await app.listen({ host: "127.0.0.1", port: 0 });
      const env = {
        AGENTS_HUB_URL: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
        AGENTS_HUB_TOKEN: outsider,
        AGENTS_HUB_PROJECT_ID: project,
      };
      const denied = await runDoctor({ env, runtimeVersion: "24.12.0" });
      expect(denied.ok).toBe(false);
      expect(
        denied.checks.find((check: { name: string }) => check.name === "membership")?.code,
      ).toBe("FORBIDDEN");
      app.ctx.authService.revokeToken(app.ctx.authService.verifyToken(token).tokenId, owner);
      const revoked = await runDoctor({
        env: { ...env, AGENTS_HUB_TOKEN: token },
        runtimeVersion: "24.12.0",
      });
      expect(
        revoked.checks.find((check: { name: string }) => check.name === "identity")?.code,
      ).toBe("UNAUTHENTICATED");
      expect(JSON.stringify({ denied, revoked })).not.toContain(token);
      expect(JSON.stringify({ denied, revoked })).not.toContain(outsider);
      expect(app.ctx.sessionService.getActiveSessions(project)).toEqual([]);
      await expect(
        promisify(execFile)(process.execPath, [path.resolve("scripts/doctor.mjs"), "--json"], {
          env: { ...process.env, ...env, AGENTS_HUB_TOKEN: token },
        }),
      ).rejects.toMatchObject({ code: 1, stdout: expect.not.stringContaining(token) });
    } finally {
      await app.close();
      app.ctx.db.close();
    }
  });

  it("rejects unsafe URLs before sending credentials and redacts arbitrary remote errors", async () => {
    let requests = 0;
    const credential = "ah_PRIVATE_TEST_CREDENTIAL";
    for (const url of [
      "http://remote.example",
      `https://user:${credential}@example.test`,
      `https://example.test/?token=${credential}`,
    ]) {
      const result = await runDoctor({
        env: { AGENTS_HUB_URL: url, AGENTS_HUB_TOKEN: credential },
        runtimeVersion: "24.12.0",
        fetchImpl: () => {
          requests++;
          throw new Error("Unexpected network access");
        },
      });
      expect(result.checks.find((check: { name: string }) => check.name === "url")?.code).toBe(
        "URL_INVALID",
      );
      expect(JSON.stringify(result)).not.toContain(credential);
    }
    expect(requests).toBe(0);
    const result = await runDoctor({
      env: { AGENTS_HUB_URL: "https://example.test", AGENTS_HUB_TOKEN: credential },
      runtimeVersion: "24.12.0",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: credential, message: `Bearer ${credential}` } }),
          { status: 401 },
        ),
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });
});
