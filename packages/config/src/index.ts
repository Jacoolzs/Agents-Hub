import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  DATABASE_URL: z.string().min(1).default("./data/agents-hub.sqlite"),
  CORS_ORIGINS: z.string().min(1).default("http://localhost:5173"),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  LOCK_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(60).default(15),
  SESSION_IDLE_SECONDS: z.coerce.number().int().min(30).default(60),
  SESSION_EXPIRE_SECONDS: z.coerce.number().int().min(90).default(180),
  RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(1).default(60000),
  RATE_LIMIT_USER_PER_MINUTE: z.coerce.number().int().min(1).default(3000),
  WS_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(200),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  WEB_STATIC_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): EnvConfig {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const errorDetails = result.error.errors
      .map((err) => `${err.path.join(".")}: ${err.message}`)
      .join(", ");
    throw new Error(`Invalid environment configuration: ${errorDetails}`);
  }
  return result.data;
}
