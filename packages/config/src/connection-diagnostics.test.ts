import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { diagnoseHubAccess } from "./connection-diagnostics.js";

const token = `ah_${"s".repeat(32)}`;
const connection = { baseUrl: "https://hub.example", token, projectId: randomUUID() };
const response = (data: unknown) => new Response(JSON.stringify({ data }));
const network = () =>
  vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("/health/ready")) return response({ status: "ready" });
    if (String(url).endsWith("/capabilities"))
      return response({
        api_version: "v1",
        contract_revision: 1,
        features: ["exclusive_instances", "cursor_recovery", "explicit_ack", "idempotent_commands"],
      });
    if (String(url).endsWith("/tokens")) return response([{ token, private: "never shown" }]);
    return response({ project_id: connection.projectId });
  });
describe("bounded passive access diagnostics", () => {
  it("uses at most four GETs without cookies/redirects and returns only fixed guidance", async () => {
    const http = network();
    const result = await diagnoseHubAccess(connection, http);
    expect(result.ok).toBe(true);
    expect(http).toHaveBeenCalledTimes(4);
    for (const [, options] of http.mock.calls)
      expect(options).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("never shown");
    expect(JSON.stringify(result)).not.toContain(connection.projectId);
  });
  it("reports authorization and permission failures without echoing remote errors", async () => {
    for (const status of [401, 403]) {
      const http = network();
      http.mockImplementation(async (url) =>
        String(url).endsWith("/tokens")
          ? new Response(JSON.stringify({ error: { code: token, message: `Bearer ${token}` } }), {
              status,
            })
          : response({ status: "ready" }),
      );
      const result = await diagnoseHubAccess(connection, http);
      expect(result.checks.find((check) => check.name === "identity")?.code).toBe(
        status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
      );
      expect(result.checks.find((check) => check.name === "membership")?.status).toBe("skipped");
      expect(http).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(result)).not.toContain(token);
    }
    const http = network();
    const defaultResponse = http.getMockImplementation();
    if (!defaultResponse) throw new Error("Missing test transport");
    http.mockImplementation(async (url, options) =>
      String(url).includes("/projects/")
        ? new Response("{}", { status: 403 })
        : defaultResponse(url, options),
    );
    expect(
      (await diagnoseHubAccess(connection, http)).checks.find(
        (check) => check.name === "membership",
      )?.code,
    ).toBe("FORBIDDEN");
  });
  it("rejects unsafe URLs before networking and bounds malformed/large remote replies", async () => {
    const http = network();
    for (const baseUrl of [
      "http://remote.example",
      `https://user:${token}@hub.example`,
      `https://hub.example/?token=${token}`,
    ]) {
      expect((await diagnoseHubAccess({ ...connection, baseUrl }, http)).ok).toBe(false);
    }
    expect(http).not.toHaveBeenCalled();
    for (const body of ["null", "broken", "x".repeat(262145)]) {
      http.mockImplementation(async () => new Response(body));
      const result = await diagnoseHubAccess(connection, http);
      expect(result.ok).toBe(false);
      expect(result.checks.find((check) => check.name === "identity")?.code).toBe(
        "INVALID_RESPONSE",
      );
    }
    http.mockImplementation(async () => {
      throw new Error(`Bearer ${token}`);
    });
    const unreachable = await diagnoseHubAccess(connection, http);
    expect(unreachable.checks.find((check) => check.name === "compatibility")?.code).toBe(
      "UNREACHABLE",
    );
    expect(JSON.stringify(unreachable)).not.toContain(token);
  });
});
