import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("Hub Server bootstrap", () => {
  it("starts and responds to /health endpoint", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "hub-server" });
    await app.close();
  });
});
