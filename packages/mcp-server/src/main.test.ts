import { describe, expect, it } from "vitest";
import { getMcpServerBanner } from "./main.js";

describe("mcp server bootstrap", () => {
  it("provides server banner", () => {
    expect(getMcpServerBanner()).toBe("Agents-Hub MCP Server ready");
  });
});
