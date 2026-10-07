export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isLastAttempt = attempt === maxRetries;
      const statusCode =
        (err as { status?: number; statusCode?: number })?.status ??
        (err as { status?: number; statusCode?: number })?.statusCode;

      const isNetworkError =
        (err as { code?: string })?.code === "ECONNRESET" ||
        (err as { code?: string })?.code === "ECONNREFUSED" ||
        (err as { code?: string })?.code === "ETIMEDOUT";

      const isRetryable =
        (typeof statusCode === "number" && RETRYABLE_STATUS_CODES.has(statusCode)) ||
        isNetworkError;

      if (isLastAttempt || !isRetryable) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw new Error("Retry attempts exhausted");
}
