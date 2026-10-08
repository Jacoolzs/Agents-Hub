import type { EnvConfig } from "@agents-hub/config";
import type { FastifyRequest } from "fastify";
import type { AuthContext } from "../auth/auth-service.js";

export interface RouteDependencies {
  config: Partial<EnvConfig> | undefined;
  corsOrigins: string[];
  getAuthenticatedUserId(req: FastifyRequest, requiredScope?: string): string;
  getAuth(req: FastifyRequest): AuthContext;
  requireScope(auth: AuthContext, requiredScope: string): void;
  command<T>(
    req: FastifyRequest,
    userId: string,
    projectId: string,
    operation: string,
    payload: unknown,
    execute: () => T,
    bodyKey?: unknown,
  ): T;
}
