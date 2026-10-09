import { AppError, BROWSER_AUDIENCE } from "@agents-hub/shared";
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
  app.addHook("onClose", async () => limiter.destroy());
  app.post("/v1/web/entry/preview", async (req, reply) => {
    limiter.check(req, reply);
    assertWebOrigin(req, origins);
    reply.header("cache-control", "no-store");
    return { data: ctx.webAccessService.preview(req.body), request_id: req.id };
  });
  app.post("/v1/web/entry", async (req, reply) => {
    limiter.check(req, reply);
    const origin = assertWebOrigin(req, origins);
    const result = ctx.webAccessService.exchange(req.body, req.id);
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", sessionCookie(result.secret, origin.startsWith("https:")));
    return { data: result.profile, request_id: req.id };
  });
  app.get("/v1/web/session", async (req, reply) => {
    const identity = getAuth(req);
    if (!identity.browser)
      throw new AppError("UNAUTHENTICATED", "Abre tu sesión humana en el portal.");
    reply.header("cache-control", "no-store");
    return { data: ctx.webAccessService.profile(identity), request_id: req.id };
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
