import { z } from "zod";

export const ApiErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PROJECT_NOT_FOUND",
  "INVALID_INPUT",
  "MESSAGE_TOO_LARGE",
  "CURSOR_INVALID",
  "LOCK_CONFLICT",
  "LOCK_NOT_OWNER",
  "SESSION_EXPIRED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  request_id: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export class AppError extends Error {
  public readonly code: ApiErrorCode;
  public readonly requestId: string;
  public readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    requestId: string = crypto.randomUUID(),
    details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }

  public toResponse(): ApiError {
    return {
      code: this.code,
      message: this.message,
      request_id: this.requestId,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
