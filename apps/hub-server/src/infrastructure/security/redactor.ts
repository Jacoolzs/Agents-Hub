/**
 * Sanitizes sensitive credentials, tokens and authorization headers from logs and error payloads.
 */
export function redactSecrets(input: unknown): unknown {
  if (typeof input === "string") {
    return input
      .replace(/ah_[A-Za-z0-9_-]+/g, "ah_***REDACTED***")
      .replace(/wst_[A-Za-z0-9_-]+/g, "wst_***REDACTED***")
      .replace(/ahi_[A-Za-z0-9_-]+/g, "ahi_***REDACTED***")
      .replace(/ahb_[A-Za-z0-9_-]+/g, "ahb_***REDACTED***")
      .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***REDACTED***")
      .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***REDACTED***");
  }

  if (Array.isArray(input)) {
    return input.map(redactSecrets);
  }

  if (input !== null && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (/token|authorization|cookie|secret|password/i.test(key) && typeof value === "string") {
        output[key] = "***REDACTED***";
      } else {
        output[key] = redactSecrets(value);
      }
    }
    return output;
  }

  return input;
}
