import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { RateLimiter } from "./infrastructure/security/rate-limiter.js";

describe("Rate Limiting, Health Diagnostics & Secret Redaction (Phase 6 Operations)", () => {
  it("enforces granular rate limiting per IP and sets standard RFC headers", async () => {
    // Custom tight rate limiter: max 3 requests per IP in 60s
    const tightLimiter = new RateLimiter({
      ipRule: { windowMs: 60_000, max: 3 },
      identityRule: { windowMs: 60_000, max: 10 },
    });

    const app = buildApp(
      { NODE_ENV: "production", CORS_ORIGINS: "http://localhost:5173" },
      undefined,
      tightLimiter,
    );
    await app.listen({ port: 0 });

    try {
      // 1st request -> allowed
      const res1 = await app.inject({ method: "GET", url: "/v1/projects/fake-id" });
      expect(res1.headers["ratelimit-limit"]).toBe("3");
      expect(res1.headers["ratelimit-remaining"]).toBe("2");
      expect(Number(res1.headers["ratelimit-reset"])).toBeGreaterThan(0);

      // 2nd request -> allowed
      const res2 = await app.inject({ method: "GET", url: "/v1/projects/fake-id" });
      expect(res2.headers["ratelimit-remaining"]).toBe("1");

      // 3rd request -> allowed
      const res3 = await app.inject({ method: "GET", url: "/v1/projects/fake-id" });
      expect(res3.headers["ratelimit-remaining"]).toBe("0");

      // 4th request -> blocked with 429 RATE_LIMITED
      const res4 = await app.inject({ method: "GET", url: "/v1/projects/fake-id" });
      expect(res4.statusCode).toBe(429);
      expect(res4.headers["retry-after"]).toBeDefined();
      expect(res4.headers["ratelimit-remaining"]).toBe("0");
      expect(res4.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });

  it("enforces granular rate limiting per authenticated Identity", async () => {
    // Custom tight limiter: max 2 requests per Identity in 60s
    const tightLimiter = new RateLimiter({
      ipRule: { windowMs: 60_000, max: 50 },
      identityRule: { windowMs: 60_000, max: 2 },
    });

    const app = buildApp(
      { NODE_ENV: "production", CORS_ORIGINS: "http://localhost:5173" },
      undefined,
      tightLimiter,
    );
    await app.listen({ port: 0 });

    const token = app.ctx.authService.createToken("rate-limited-user", "agents-hub");

    try {
      // Request 1
      const res1 = await app.inject({
        method: "GET",
        url: "/v1/projects/any-project",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res1.headers["ratelimit-remaining"]).toBe("1");

      // Request 2
      const res2 = await app.inject({
        method: "GET",
        url: "/v1/projects/any-project",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res2.headers["ratelimit-remaining"]).toBe("0");

      // Request 3 -> throttled by identity
      const res3 = await app.inject({
        method: "GET",
        url: "/v1/projects/any-project",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res3.statusCode).toBe(429);
      expect(res3.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });

  it("excludes health endpoints from rate limits", async () => {
    const strictLimiter = new RateLimiter({
      ipRule: { windowMs: 60_000, max: 1 },
      identityRule: { windowMs: 60_000, max: 1 },
    });

    const app = buildApp(
      { NODE_ENV: "production", CORS_ORIGINS: "http://localhost:5173" },
      undefined,
      strictLimiter,
    );
    await app.listen({ port: 0 });

    try {
      // Health check calls should not be throttled regardless of volume
      for (let i = 0; i < 5; i++) {
        const liveRes = await app.inject({ method: "GET", url: "/health/live" });
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.json().status).toBe("ok");

        const readyRes = await app.inject({ method: "GET", url: "/health/ready" });
        expect(readyRes.statusCode).toBe(200);
        const readyData = readyRes.json();
        expect(readyData.status).toBe("ready");
        expect(readyData.request_id).toBeDefined();
        expect(readyData.database).toBeUndefined();
        expect(readyData.websockets).toBeUndefined();
        expect(readyData.process).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it("redacts sensitive tokens from error messages and details", async () => {
    const app = buildApp({
      NODE_ENV: "production",
      CORS_ORIGINS: "http://localhost:5173",
    });
    await app.listen({ port: 0 });

    try {
      // Test invalid input that includes a token-like string in query
      const leakAttemptToken = "ah_super_secret_token_123456789";
      const res = await app.inject({
        method: "GET",
        url: `/v1/projects/test/inbox?session_id=valid&after=${leakAttemptToken}`,
        headers: { authorization: `Bearer ${leakAttemptToken}` },
      });

      const bodyStr = res.payload;
      expect(bodyStr).not.toContain("ah_super_secret_token_123456789");
    } finally {
      await app.close();
    }
  });
});
