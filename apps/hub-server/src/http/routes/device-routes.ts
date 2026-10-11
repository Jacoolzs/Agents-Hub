import { AppError, DeviceConfirmInputSchema } from "@agents-hub/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../app.js";
import { RateLimiter } from "../../infrastructure/security/rate-limiter.js";
import type { AuthContext } from "../auth/auth-service.js";
import { assertWebOrigin } from "../auth/web-policy.js";

export function registerDeviceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  origins: string[],
  getAuth: (req: FastifyRequest) => AuthContext,
) {
  const limiter = new RateLimiter({ ipRule: { windowMs: 60000, max: 10 } });
  app.addHook("onClose", async () => limiter.destroy());
  const human = (req: FastifyRequest) => {
    assertWebOrigin(req, origins);
    const identity = getAuth(req);
    if (!identity.browser)
      throw new AppError("UNAUTHENTICATED", "Abre tu sesión humana en el portal.");
    return identity;
  };
  app.post("/v1/devices/requests", async (req, reply) => {
    limiter.check(req, reply);
    reply.header("cache-control", "no-store");
    return { data: ctx.deviceService.request(req.body), request_id: req.id };
  });
  app.post("/v1/devices/exchange", async (req, reply) => {
    limiter.check(req, reply);
    reply.header("cache-control", "no-store");
    return { data: ctx.deviceService.exchange(req.body, req.id), request_id: req.id };
  });
  app.post("/v1/web/devices/preview", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return { data: ctx.deviceService.preview(human(req), req.body), request_id: req.id };
  });
  app.post("/v1/web/devices/approve", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return { data: ctx.deviceService.approve(human(req), req.body, req.id), request_id: req.id };
  });
  app.get("/v1/web/devices", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return { data: ctx.deviceService.list(human(req)), request_id: req.id };
  });
  app.post<{ Params: { tokenId: string } }>(
    "/v1/web/devices/:tokenId/revoke",
    async (req, reply) => {
      const identity = human(req);
      if (!DeviceConfirmInputSchema.safeParse(req.body).success)
        throw new AppError("INVALID_INPUT", "Confirma la revocación.");
      reply.header("cache-control", "no-store");
      const result = ctx.deviceService.revoke(identity, req.params.tokenId, req.id);
      ctx.wsHub.revalidate();
      return { data: result, request_id: req.id };
    },
  );
}
