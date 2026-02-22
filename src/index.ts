#!/usr/bin/env node

// --setup flag: run interactive setup wizard instead of server
if (process.argv.includes("--setup")) {
  import("./setup.js");
} else {
  import("@modelcontextprotocol/sdk/server/stdio.js").then(
    async ({ StdioServerTransport }) => {
      const { createServer } = await import("./server.js");
      const { server, webClient } = await createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("[curseforge-mcp] Server running on stdio");

      const shutdown = async () => {
        console.error("[curseforge-mcp] Shutting down...");
        try { await webClient.close(); } catch {}
        try { await server.close(); } catch {}
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    },
  ).catch((err) => {
    console.error("[curseforge-mcp] Fatal error:", err);
    process.exit(1);
  });
}
