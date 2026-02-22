import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { CoreApiClient } from "./clients/curseforge-client.js";
import { CfWidgetClient } from "./clients/cfwidget-client.js";
import { UploadApiClient } from "./clients/upload-client.js";
import { WebClient } from "./clients/web-client.js";
import { registerCoreApiTools } from "./tools/core-api.js";
import { registerUploadApiTools } from "./tools/upload-api.js";
import { registerWebApiTools } from "./tools/web-api.js";

export async function createServer(): Promise<{ server: McpServer; webClient: WebClient }> {
  const config = loadConfig();

  const server = new McpServer({
    name: "curseforge-mcp",
    version: "0.2.0",
  });

  // CFWidget — always available, no API key needed
  const cfwidget = new CfWidgetClient();

  // Core API client — null if no API key
  let coreClient: CoreApiClient | null = null;
  if (config.curseforgeApiKey) {
    try {
      coreClient = new CoreApiClient(config);
      console.error("[curseforge-mcp] Core API client ready");
    } catch (e) {
      console.error(
        `[curseforge-mcp] Failed to init Core API: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else {
    console.error(
      "[curseforge-mcp] No CURSEFORGE_API_KEY — Core API tools disabled, CFWidget fallback active",
    );
  }

  // Always register Core API tools (CFWidget tools always available, Core API tools only if key)
  registerCoreApiTools(server, coreClient, cfwidget);

  // Upload API tools — only if author token is provided
  if (config.curseforgeAuthorToken) {
    try {
      const uploadClient = new UploadApiClient(config);
      registerUploadApiTools(server, uploadClient);
      console.error("[curseforge-mcp] Upload API tools registered");
    } catch (e) {
      console.error(
        `[curseforge-mcp] Failed to init Upload API: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else {
    console.error(
      "[curseforge-mcp] No CURSEFORGE_AUTHOR_TOKEN — Upload tools disabled",
    );
  }

  // Web API tools — always available
  const webClient = new WebClient(config);
  await webClient.init();
  registerWebApiTools(server, webClient);
  console.error(
    `[curseforge-mcp] Web API tools registered (cookies: ${webClient.hasCookies() ? "loaded" : "none"})`,
  );

  return { server, webClient };
}
