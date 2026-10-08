import { AppError } from "@agents-hub/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app.js";
import type { RouteDependencies } from "./dependencies.js";

export function registerEventRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  dependencies: RouteDependencies,
): void {
  const { sessionService, authService, wsTicketService, wsHub } = ctx;
  const { requireScope, corsOrigins, config } = dependencies;

  // WebSocket endpoint for real-time events
  void app.register(async (wsScope) => {
    wsScope.get("/v1/projects/:projectId/events", { websocket: true }, (socket, req) => {
      const params = req?.params as { projectId?: string } | undefined;
      let projectId = params?.projectId;
      if (!projectId && req?.url) {
        const match = req.url.match(/\/v1\/projects\/([^/?]+)\/events/);
        if (match?.[1]) {
          projectId = match[1];
        }
      }

      if (!projectId) {
        socket.close(1008, "Invalid project ID");
        return;
      }

      const isProduction =
        process.env.NODE_ENV === "production" || config?.NODE_ENV === "production";
      const origin = req?.headers?.origin;

      // Origin policy: in production or strict CORS, Origin header is mandatory
      if (!origin) {
        if (isProduction || !corsOrigins.includes("*")) {
          socket.close(1008, "Origin header is required");
          return;
        }
      } else if (!corsOrigins.includes(origin) && !corsOrigins.includes("*")) {
        socket.close(1008, "Invalid Origin");
        return;
      }

      // Extract ticket or query token
      let ticket: string | undefined;
      if (req?.query && typeof req.query === "object" && "ticket" in req.query) {
        ticket = String(req.query.ticket);
      } else if (req?.url) {
        try {
          const u = new URL(req.url, "http://localhost");
          if (u.searchParams.has("ticket")) {
            ticket = u.searchParams.get("ticket") ?? undefined;
          }
        } catch {
          // ignore URL parse error
        }
      }

      let queryToken: string | undefined;
      if (req?.query && typeof req.query === "object" && "token" in req.query) {
        queryToken = String(req.query.token);
      } else if (req?.url) {
        try {
          const u = new URL(req.url, "http://localhost");
          if (u.searchParams.has("token")) {
            queryToken = u.searchParams.get("token") ?? undefined;
          }
        } catch {
          // ignore URL parse error
        }
      }

      // Query string token is prohibited in production
      if (queryToken && isProduction) {
        socket.close(1008, "Token query param prohibited in production");
        return;
      }

      const authHeader = req?.headers?.authorization;
      let token = "";
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.substring(7).trim();
      } else if (!isProduction && queryToken) {
        token = queryToken;
      }

      let sessionId: string | undefined;
      if (req?.query && typeof req.query === "object" && "session_id" in req.query) {
        sessionId = String(req.query.session_id);
      } else if (req?.url) {
        try {
          const u = new URL(req.url, "http://localhost");
          if (u.searchParams.has("session_id")) {
            sessionId = u.searchParams.get("session_id") ?? undefined;
          }
        } catch {
          // ignore URL parse error
        }
      }

      try {
        if (!sessionId) {
          socket.close(1008, "session_id is required");
          return;
        }

        let authenticatedUserId = "";
        let authenticatedTokenId: string | undefined;
        if (ticket) {
          const consumed = wsTicketService.consumeTicket(ticket, projectId, sessionId);
          authenticatedUserId = consumed.userId;
          authenticatedTokenId = consumed.tokenId;
        } else if (token) {
          const verified = authService.verifyToken(token);
          requireScope(verified, "messages:read");
          authService.checkProjectPermission(verified.userId, projectId);
          authenticatedUserId = verified.userId;
          if (verified.projectId && verified.projectId !== projectId)
            throw new AppError("FORBIDDEN", "Token is bound to another project");
          authenticatedTokenId = verified.tokenId;
        } else {
          socket.close(1008, "Authentication required: missing ticket or token");
          return;
        }

        authService.checkProjectPermission(authenticatedUserId, projectId);
        if (!authenticatedTokenId || !authService.isTokenActive(authenticatedTokenId))
          throw new AppError("UNAUTHENTICATED", "Token is no longer active");
        const session = sessionService.validateSessionForUser(
          sessionId,
          authenticatedUserId,
          projectId,
        );

        const registered = wsHub.register({
          socket,
          projectId,
          userId: authenticatedUserId,
          agentId: session.agent_id,
          authorized: () => {
            try {
              authService.checkProjectPermission(authenticatedUserId, projectId);
              sessionService.validateSessionForUser(sessionId, authenticatedUserId, projectId);
              return (
                authenticatedTokenId !== undefined &&
                authService.isTokenActive(authenticatedTokenId)
              );
            } catch {
              return false;
            }
          },
        });

        if (registered)
          socket.send(JSON.stringify({ type: "connected", projectId, agentId: session.agent_id }));
      } catch {
        socket.close(1008, "Unauthorized");
      }
    });
  });
}
