import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("loads valid default configuration", () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(8787);
    expect(config.DATABASE_URL).toBe("./data/agents-hub.sqlite");
    expect(config.LOCK_DEFAULT_TTL_SECONDS).toBe(300);
  });

  it("parses and coerces numeric env variables", () => {
    const config = loadConfig({
      PORT: "9000",
      AUTH_TOKEN_TTL_SECONDS: "7200",
    });
    expect(config.PORT).toBe(9000);
    expect(config.AUTH_TOKEN_TTL_SECONDS).toBe(7200);
  });

  it("throws descriptive error for invalid values", () => {
    expect(() =>
      loadConfig({
        PORT: "not-a-port",
      }),
    ).toThrowError(/Invalid environment configuration: PORT/);
  });
});
