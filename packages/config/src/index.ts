import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  DATABASE_URL: z.string().min(1).default("./data/agents-hub.sqlite"),
  CORS_ORIGINS: z.string().min(1).default("http://localhost:5173"),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  LOCK_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
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
