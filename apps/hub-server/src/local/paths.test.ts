import path from "node:path";
import { describe, expect, it } from "vitest";
import { companionPaths } from "./paths.js";

const checkout = path.resolve("fixture checkout with spaces");
const data = path.resolve("fixture user data with spaces");
const resources = path.resolve("fixture installed resources");

describe("companion path contract", () => {
  it("keeps the historical development database, anchored to the checkout", () => {
    const paths = companionPaths(checkout, {});
    expect(paths.database).toBe(path.join(checkout, "data", "agents-hub.sqlite"));
    expect(paths.web).toBe(path.join(checkout, "apps", "web", "dist"));
    expect(companionPaths(checkout, { DATABASE_URL: "./data/old.sqlite" }).database).toBe(
      path.join(checkout, "data", "old.sqlite"),
    );
  });
  it("separates installed resources, writable data and relative database overrides", () => {
    const env = { AGENTS_HUB_RESOURCE_DIR: resources, AGENTS_HUB_DATA_DIR: data };
    expect(companionPaths(checkout, env)).toEqual({
      resources,
      data,
      database: path.join(data, "agents-hub.sqlite"),
      web: path.join(resources, "apps", "web", "dist"),
    });
    expect(
      companionPaths(checkout, { ...env, DATABASE_URL: "nested/custom.sqlite" }).database,
    ).toBe(path.join(data, "nested", "custom.sqlite"));
  });
  it("preserves deliberate absolute databases and ephemeral test databases", () => {
    const database = path.resolve("existing database.sqlite");
    expect(companionPaths(checkout, { DATABASE_URL: database }).database).toBe(database);
    expect(companionPaths(checkout, { DATABASE_URL: ":memory:" }).database).toBe(":memory:");
  });
  it("rejects ambiguous installed paths and relative database escapes before any IO", () => {
    for (const env of [
      { AGENTS_HUB_RESOURCE_DIR: "relative" },
      { AGENTS_HUB_DATA_DIR: "relative" },
      { AGENTS_HUB_RESOURCE_DIR: resources },
      { AGENTS_HUB_DATA_DIR: data, DATABASE_URL: "../outside.sqlite" },
      { AGENTS_HUB_DATA_DIR: data, DATABASE_URL: "." },
      { DATABASE_URL: "" },
    ])
      expect(() => companionPaths(checkout, env)).toThrow();
    if (process.platform === "win32") {
      expect(() => companionPaths(checkout, { AGENTS_HUB_DATA_DIR: "\\ambiguous" })).toThrow();
      expect(() => companionPaths(checkout, { DATABASE_URL: "\\ambiguous.sqlite" })).toThrow();
      expect(() => companionPaths(checkout, { DATABASE_URL: "C:ambiguous.sqlite" })).toThrow();
    }
  });
});
