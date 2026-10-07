import type { EnvConfig } from "@agents-hub/config";
import fastify, { type FastifyInstance } from "fastify";

export function buildApp(config?: Partial<EnvConfig>): FastifyInstance {
  const app = fastify({
    logger: false,
  });

  app.get("/health", async () => {
    return { status: "ok", service: "hub-server" };
  });

  return app;
}
