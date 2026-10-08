export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal | undefined;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err: unknown) {
      const isLastAttempt = attempt === maxRetries;
      const statusCode =
        (err as { status?: number; statusCode?: number })?.status ??
        (err as { status?: number; statusCode?: number })?.statusCode;

      options.signal?.throwIfAborted();
      const networkCode =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      const isNetworkError = [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(networkCode ?? "");

      const isRetryable =
        (typeof statusCode === "number" && RETRYABLE_STATUS_CODES.has(statusCode)) ||
        isNetworkError;

      if (isLastAttempt || !isRetryable) {
        throw err;
      }

      const { setTimeout: sleep } = await import("node:timers/promises");
      await sleep(delay + Math.random() * delay * 0.2, undefined, { signal: options.signal });
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw new Error("Retry attempts exhausted");
}
