import { runServer } from "./server.js";

// Entrypoint executed by Claude Code, Cursor, or CLI via stdio
if (process.env.NODE_ENV !== "test") {
  runServer().catch(() => {
    // Strict rule: all diagnostics to stderr, stdout is reserved for JSON-RPC
    console.error("Agents-Hub MCP Server failed. Check Hub URL, token and connection.");
    process.exit(1);
  });
}

export * from "./server.js";
export * from "./client/hub-client.js";
