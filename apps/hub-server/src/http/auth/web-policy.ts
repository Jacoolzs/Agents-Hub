import { AppError } from "@agents-hub/shared";
import type { FastifyRequest } from "fastify";

export function webCookie(req: FastifyRequest, secure?: boolean) {
  const names =
    secure === undefined ? ["ah_web", "__Host-ah_web"] : [secure ? "__Host-ah_web" : "ah_web"];
  const values =
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => names.some((name) => part.startsWith(`${name}=`))) ?? [];
  if (values.length !== 1) return undefined;
  const item = values[0];
  const value = item?.slice(item.indexOf("=") + 1);
  return value && /^ah_[A-Za-z0-9_-]{32}$/.test(value) ? value : undefined;
}
export function assertWebOrigin(req: FastifyRequest, origins: string[]): string {
  const candidates = origins.filter((origin) => {
    try {
      const url = new URL(origin);
      return (
        url.origin === origin &&
        url.host === req.headers.host &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
            ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)))
      );
    } catch {
      return false;
    }
  });
  const origin = req.headers.origin;
  if (
    !candidates.length ||
    (origin && !candidates.includes(origin)) ||
    (req.method !== "GET" && !origin)
  )
    throw new AppError("FORBIDDEN", "Abre el portal desde su dirección autorizada.");
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
    throw new AppError("FORBIDDEN", "Esta operación requiere el mismo origen del portal.");
  return origin ?? candidates.find((o) => o.startsWith("https:")) ?? (candidates[0] as string);
}
export function sessionCookie(secret: string, secure: boolean, clear = false) {
  return `${secure ? "__Host-ah_web" : "ah_web"}=${secret}; HttpOnly; SameSite=Strict; Path=${secure ? "/" : "/v1/"}; Max-Age=${clear ? 0 : 28800}${secure ? "; Secure" : ""}`;
}
