#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[curseforge-mcp] Server running on stdio");

  const shutdown = async () => {
    console.error("[curseforge-mcp] Shutting down...");
    try {
      await server.close();
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[curseforge-mcp] Fatal error:", err);
  process.exit(1);
});
