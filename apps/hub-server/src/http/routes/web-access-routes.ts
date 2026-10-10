import { createHash } from "node:crypto";
import { AppError, BROWSER_AUDIENCE, WebLoginInputSchema } from "@agents-hub/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app.js";
import { RateLimiter } from "../../infrastructure/security/rate-limiter.js";
import type { AuthContext } from "../auth/auth-service.js";
import { assertWebOrigin, sessionCookie, webCookie } from "../auth/web-policy.js";

export function registerWebAccessRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  origins: string[],
  getAuth: (req: FastifyRequest) => AuthContext,
) {
  const limiter = new RateLimiter({ ipRule: { windowMs: 60000, max: 30 } });
  const passwordLimiter = new RateLimiter({
    ipRule: { windowMs: 60000, max: 15 },
    identityRule: { windowMs: 300000, max: 5 },
  });
  app.addHook("onClose", async () => limiter.destroy());
  app.addHook("onClose", async () => passwordLimiter.destroy());
  app.post("/v1/web/login", async (req, reply) => {
    const origin = assertWebOrigin(req, origins);
    const parsed = WebLoginInputSchema.safeParse(req.body);
    const key = parsed.success
      ? createHash("sha256").update(parsed.data.username).digest("hex")
      : "invalid";
    passwordLimiter.check(req, reply, key);
    reply.header("cache-control", "no-store");
    const result = await ctx.webAccountService.login(req.body, req.id);
    if ("secret" in result) {
      reply.header("set-cookie", sessionCookie(result.secret, origin.startsWith("https:")));
      return { data: result.profile, request_id: req.id };
    }
    return { data: result, request_id: req.id };
  });
  app.get("/v1/web/account", async (req, reply) => {
    const identity = getAuth(req);
    if (!identity.browser)
      throw new AppError("UNAUTHENTICATED", "Abre tu sesión humana en el portal.");
    reply.header("cache-control", "no-store");
    return {
      data: { registered: ctx.webAccountService.registered(identity.userId) },
      request_id: req.id,
    };
  });
  app.post("/v1/web/account", async (req, reply) => {
    const identity = getAuth(req);
    if (!identity.browser)
      throw new AppError("UNAUTHENTICATED", "Abre tu sesión humana en el portal.");
    passwordLimiter.check(req, reply, identity.userId);
    reply.header("cache-control", "no-store");
    return {
      data: await ctx.webAccountService.enroll(identity, req.body, req.id),
      request_id: req.id,
    };
  });
  app.post("/v1/web/entry/preview", async (req, reply) => {
    limiter.check(req, reply);
    assertWebOrigin(req, origins);
    reply.header("cache-control", "no-store");
    const profile = ctx.webAccessService.preview(req.body);
    return {
      data: {
        ...profile,
        account_registered: ctx.webAccountService.registered(profile.user.user_id),
      },
      request_id: req.id,
    };
  });
  app.post("/v1/web/entry", async (req, reply) => {
    limiter.check(req, reply);
    const origin = assertWebOrigin(req, origins);
    const result = ctx.webAccessService.exchange(req.body, req.id);
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", sessionCookie(result.secret, origin.startsWith("https:")));
    return {
      data: {
        ...result.profile,
        account_registered: ctx.webAccountService.registered(result.profile.user.user_id),
      },
      request_id: req.id,
    };
  });
  app.get("/v1/web/session", async (req, reply) => {
    const identity = getAuth(req);
    if (!identity.browser)
      throw new AppError("UNAUTHENTICATED", "Abre tu sesión humana en el portal.");
    reply.header("cache-control", "no-store");
    return {
      data: {
        ...ctx.webAccessService.profile(identity),
        account_registered: ctx.webAccountService.registered(identity.userId),
      },
      request_id: req.id,
    };
  });
  app.post("/v1/web/logout", async (req, reply) => {
    const origin = assertWebOrigin(req, origins);
    const secret = webCookie(req, origin.startsWith("https:"));
    if (secret) {
      let identity: AuthContext | undefined;
      try {
        identity = ctx.authService.verifyToken(secret, BROWSER_AUDIENCE);
      } catch (error) {
        if (!(error instanceof AppError) || !["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code))
          throw error;
      }
      if (identity) ctx.webAccessService.logout(identity, req.id);
    }
    ctx.wsHub.revalidate();
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", sessionCookie("", origin.startsWith("https:"), true));
    return { data: { connected: false }, request_id: req.id };
  });
}
