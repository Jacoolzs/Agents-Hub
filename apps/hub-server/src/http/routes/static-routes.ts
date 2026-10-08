import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// Serve the production bundle and API from one origin; never expose Vite dev or workspace sources.
export function registerStaticRoutes(app: FastifyInstance, directory: string) {
  const root = path.resolve(directory);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  app.get("/*", async (req, reply) => {
    const route = req.url.split("?")[0] ?? "/";
    const relative = route === "/" ? "index.html" : route.slice(1);
    if (relative !== "index.html" && !/^assets\/[A-Za-z0-9._-]+$/.test(relative))
      return reply.code(404).send({
        error: { code: "PROJECT_NOT_FOUND", message: "Route not found" },
        request_id: reply.getHeader("x-request-id"),
      });
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`)) return reply.code(404).send();
    try {
      const data = await readFile(file);
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      reply.header("strict-transport-security", "max-age=31536000");
      reply.header(
        "cache-control",
        relative === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
      );
      return reply.type(types[path.extname(file)] ?? "application/octet-stream").send(data);
    } catch {
      return reply.code(404).send();
    }
  });
}
