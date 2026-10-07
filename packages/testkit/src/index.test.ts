import { describe, expect, it } from "vitest";
import { createFakeId } from "./index.js";

describe("testkit bootstrap", () => {
  it("generates string with expected prefix", () => {
    const id = createFakeId("agent");
    expect(id.startsWith("agent-")).toBe(true);
  });
});
