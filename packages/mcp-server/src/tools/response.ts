export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Tool execution failed";
  return text
    .replace(/\b(?:ah_|ahi_|wst_|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
export function content(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
