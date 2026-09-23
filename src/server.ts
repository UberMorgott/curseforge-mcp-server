import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { CoreApiClient } from "./clients/curseforge-client.js";
import { CfWidgetClient } from "./clients/cfwidget-client.js";
import { UploadApiClient } from "./clients/upload-client.js";
import { WebClient } from "./clients/web-client.js";
import { registerCoreApiTools } from "./tools/core-api.js";
import { registerUploadApiTools } from "./tools/upload-api.js";
import { registerWebApiTools } from "./tools/web-api.js";

// package.json sits one level above both src/ and build/.
const { version: PKG_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

// Sent to MCP clients on initialize so agents know the workflows without trial and error.
function buildInstructions(defaultGameSlug: string): string {
  return [
    "CurseForge platform tools (any game).",
    `Default game slug: ${defaultGameSlug || "(none — pass game_slug explicitly)"}.`,
    "Game IDs for Core API tools (game_id): Minecraft=432, Hytale=70216, WoW=1. search_mods defaults to 432 — always pass game_id for other games. Unknown game → get_game_versions lists all games with IDs.",
    "Project IDs: numeric everywhere (mod_id / project_id). get_project also accepts a path like \"hytale/mods/<slug>\".",
    "Upload workflow: 1) get_upload_game_versions(game_slug) → version IDs; 2) upload_file(project_id, file_path, game_version_ids, release_type, changelog). upload_file publishes immediately.",
    "Version IDs are per game: never reuse IDs from another game's list.",
    "Comments: get_comments(mod_id) → post_comment / delete_comment. Description: update_project_description. Project metadata: get_project_settings(project_id).",
    "Web API tools (unofficial) run through a dedicated browser (first call ~5 s to pass Cloudflare). Auth errors → cf_auto_extract_cookies (extracts cookies or opens a login window; retry after signing in), or cf_set_cookies to paste cookies manually.",
  ].join("\n");
}

export async function createServer(): Promise<{ server: McpServer; webClient: WebClient }> {
  const config = loadConfig();

  const server = new McpServer(
    {
      name: "curseforge-mcp",
      version: PKG_VERSION,
    },
    { instructions: buildInstructions(config.curseforgeGameSlug) },
  );

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

  // Web API tools — always available (must init before Upload API since it provides browser).
  // init() is non-blocking: on-disk cookies load instantly; auto-extraction runs in the
  // background so we never delay the MCP initialize handshake (cookie scan can take 30s+).
  const webClient = new WebClient(config);
  webClient.init();
  registerWebApiTools(server, webClient);

  // Upload API tools — only if author token is provided (native HTTP, no browser)
  if (config.curseforgeAuthorToken) {
    try {
      const uploadClient = new UploadApiClient(config, coreClient);
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
  console.error(
    `[curseforge-mcp] Web API tools registered (cookies: ${webClient.hasCookies() ? "loaded" : "none"})`,
  );

  return { server, webClient };
}
