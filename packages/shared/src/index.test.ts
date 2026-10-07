import { describe, expect, it } from "vitest";
import { SHARED_VERSION, isSharedReady } from "./index.js";

describe("shared module bootstrap", () => {
  it("exports valid version and readiness flag", () => {
    expect(SHARED_VERSION).toBe("0.1.0");
    expect(isSharedReady()).toBe(true);
  });
});
