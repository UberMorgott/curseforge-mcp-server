import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { CoreApiClient } from "../clients/curseforge-client.js";
import type { CfWidgetClient } from "../clients/cfwidget-client.js";
import {
  formatMod,
  formatModDetailed,
  formatFile,
  formatGame,
  formatCategory,
  formatProject,
  stripHtml,
  truncate,
  compact,
} from "../utils/helpers.js";
import { success, error } from "../utils/types.js";

export function registerCoreApiTools(
  server: McpServer,
  client: CoreApiClient | null,
  cfwidget: CfWidgetClient,
): void {
  // ── Tools that require API key ──

  if (client) {
    server.registerTool(
      "search_mods",
      {
        title: "Search CurseForge Mods",
        description:
          "Search mods by name, category, game version, or mod loader. Requires API key.",
        inputSchema: {
          game_id: z.number().default(432).describe("Game ID (432=Minecraft)"),
          search_filter: z.string().optional().describe("Search query"),
          slug: z.string().optional().describe("Exact mod slug"),
          category_id: z.number().optional(),
          class_id: z.number().optional().describe("6=Mods, 4471=Modpacks"),
          game_version: z.string().optional().describe("e.g. '1.20.1'"),
          mod_loader_type: z.number().optional().describe("0=Any,1=Forge,4=Fabric,5=Quilt,6=NeoForge"),
          sort_field: z.enum(["featured", "popularity", "lastUpdated", "name", "author", "totalDownloads", "category", "gameVersion", "earlyAccess", "featuredReleased", "releasedDate", "rating"]).optional().describe("Sort field"),
          sort_order: z.enum(["asc", "desc"]).optional(),
          page_index: z.number().optional().default(0),
          page_size: z.number().optional().default(10).describe("Max 50"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (params) => {
        try {
          const results = await client.searchMods(params.game_id, {
            searchFilter: params.search_filter,
            slug: params.slug,
            categoryId: params.category_id,
            classId: params.class_id,
            gameVersion: params.game_version,
            modLoaderType: params.mod_loader_type,
            sortField: params.sort_field,
            sortOrder: params.sort_order,
            index: params.page_index,
            pageSize: params.page_size,
          });
          const lines = results.data.map((m: any) => formatMod(m));
          return success(`${results.pagination.totalCount} results (showing ${results.data.length}):\n\n${lines.join("\n\n")}`);
        } catch (e) {
          return error(`search_mods: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_mod",
      {
        title: "Get Mod Details",
        description: "Get full details of a CurseForge mod by ID.",
        inputSchema: {
          mod_id: z.number().describe("CurseForge mod/project ID"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_id }) => {
        try {
          const mod = await client.getMod(mod_id);
          return success(formatModDetailed(mod));
        } catch (e) {
          return error(`get_mod: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_mod_files",
      {
        title: "Get Mod Files",
        description: "List files for a mod with optional filtering.",
        inputSchema: {
          mod_id: z.number().describe("CurseForge mod/project ID"),
          game_version: z.string().optional(),
          mod_loader_type: z.number().optional().describe("0=Any,1=Forge,4=Fabric"),
          page_index: z.number().optional().default(0),
          page_size: z.number().optional().default(10),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (params) => {
        try {
          const result = await client.getModFiles(params.mod_id, {
            gameVersion: params.game_version,
            modLoaderType: params.mod_loader_type,
            index: params.page_index,
            pageSize: params.page_size,
          });
          const lines = result.data.map((f: any) => formatFile(f));
          return success(`${result.pagination.totalCount} files (showing ${result.data.length}):\n\n${lines.join("\n\n")}`);
        } catch (e) {
          return error(`get_mod_files: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_mod_file",
      {
        title: "Get Specific File",
        description: "Get details of a specific mod file by file ID.",
        inputSchema: {
          mod_id: z.number().describe("CurseForge mod/project ID"),
          file_id: z.number().describe("File ID"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_id, file_id }) => {
        try {
          const file = await client.getModFile(mod_id, file_id);
          return success(formatFile(file));
        } catch (e) {
          return error(`get_mod_file: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_mod_description",
      {
        title: "Get Mod Description",
        description: "Get mod description as HTML or plain text.",
        inputSchema: {
          mod_id: z.number().describe("CurseForge mod/project ID"),
          format: z.enum(["html", "text"]).optional().default("text"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_id, format }) => {
        try {
          const html = await client.getModDescription(mod_id);
          const text = format === "html" ? html : stripHtml(html);
          return success(truncate(text));
        } catch (e) {
          return error(`get_mod_description: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_mod_changelog",
      {
        title: "Get File Changelog",
        description: "Get changelog for a specific mod file release.",
        inputSchema: {
          mod_id: z.number(),
          file_id: z.number(),
          format: z.enum(["html", "text"]).optional().default("text"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_id, file_id, format }) => {
        try {
          const html = await client.getModFileChangelog(mod_id, file_id);
          const text = format === "html" ? html : stripHtml(html);
          return success(truncate(text));
        } catch (e) {
          return error(`get_mod_changelog: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_download_url",
      {
        title: "Get Download URL",
        description: "Get direct download URL for a mod file.",
        inputSchema: {
          mod_id: z.number(),
          file_id: z.number(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_id, file_id }) => {
        try {
          const url = await client.getModFileDownloadURL(mod_id, file_id);
          return success(url);
        } catch (e) {
          return error(`get_download_url: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "download_mod",
      {
        title: "Download Mod File",
        description:
          "Download a mod file to a local directory. Works with any CurseForge game (Minecraft, Hytale, WoW, etc.). Streams large files efficiently.",
        inputSchema: {
          mod_id: z.number().describe("CurseForge mod/project ID"),
          file_id: z.number().describe("File ID to download"),
          destination: z.string().describe("Absolute path to directory where the file will be saved"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_id, file_id, destination }) => {
        try {
          const file = await client.getModFile(mod_id, file_id);
          const downloadUrl: string | null = (file as any).downloadUrl ?? null;
          const fileName: string = (file as any).fileName ?? `${mod_id}-${file_id}`;

          if (!downloadUrl) {
            return error(
              "This file does not allow direct downloads (mod author has restricted distribution). Use the CurseForge app instead.",
            );
          }

          await mkdir(destination, { recursive: true });
          const filePath = join(destination, fileName);

          const response = await fetch(downloadUrl);
          if (!response.ok) {
            return error(`HTTP ${response.status} ${response.statusText} downloading ${fileName}`);
          }
          if (!response.body) {
            return error("No response body received from download server");
          }

          const nodeStream = Readable.fromWeb(response.body as any);
          const fileStream = createWriteStream(filePath);
          await pipeline(nodeStream, fileStream);

          const stats = await stat(filePath);
          const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

          return success(`Downloaded: ${fileName}\nPath: ${filePath}\nSize: ${sizeMB} MB`);
        } catch (e) {
          return error(`download_mod: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_featured_mods",
      {
        title: "Get Featured Mods",
        description: "Get popular, recently updated, and featured mods for a game.",
        inputSchema: {
          game_id: z.number().default(432).describe("Game ID"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ game_id }) => {
        try {
          const result = await client.getFeaturedMods(game_id);
          const sections: string[] = [];
          if (result.featured?.length) {
            sections.push("Featured:\n" + result.featured.map((m: any) => formatMod(m)).join("\n\n"));
          }
          if (result.popular?.length) {
            sections.push("Popular:\n" + result.popular.map((m: any) => formatMod(m)).join("\n\n"));
          }
          if (result.recentlyUpdated?.length) {
            sections.push("Recently Updated:\n" + result.recentlyUpdated.map((m: any) => formatMod(m)).join("\n\n"));
          }
          return success(sections.join("\n\n---\n\n") || "No featured mods found.");
        } catch (e) {
          return error(`get_featured_mods: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_mods_batch",
      {
        title: "Get Multiple Mods",
        description: "Fetch multiple mods by ID in one request. More efficient than multiple get_mod calls.",
        inputSchema: {
          mod_ids: z.array(z.number()).describe("Array of mod IDs"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ mod_ids }) => {
        try {
          const mods = await client.getMods(mod_ids);
          const lines = mods.map((m: any) => formatMod(m));
          return success(`${mods.length} mods:\n\n${lines.join("\n\n")}`);
        } catch (e) {
          return error(`get_mods_batch: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_categories",
      {
        title: "Get Categories",
        description: "Get available mod categories for a game.",
        inputSchema: {
          game_id: z.number().default(432),
          class_id: z.number().optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ game_id, class_id }) => {
        try {
          const categories = await client.getCategories(game_id, class_id);
          const lines = categories.map((c: any) => formatCategory(c));
          return success(`${categories.length} categories:\n${lines.join("\n")}`);
        } catch (e) {
          return error(`get_categories: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );

    server.registerTool(
      "get_game_versions",
      {
        title: "Get Games / Game Details",
        description: "List all CurseForge games, or get details of a specific game.",
        inputSchema: {
          game_id: z.number().optional().describe("Specific game ID, or omit for all games"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ game_id }) => {
        try {
          if (game_id !== undefined) {
            const game = await client.getGame(game_id);
            return success(compact(game));
          }
          const games = await client.getGames();
          const lines = games.data.map((g: any) => formatGame(g));
          return success(`${games.data.length} games:\n${lines.join("\n")}`);
        } catch (e) {
          return error(`get_game_versions: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  // ── CFWidget tools — always available, no API key needed ──

  server.registerTool(
    "get_project",
    {
      title: "Get Project (no API key)",
      description:
        'Get CurseForge project info by numeric ID or path (e.g. "238222" or "minecraft/mc-mods/jei"). Works without API key via CFWidget.',
      inputSchema: {
        project: z.string().describe('Project ID or path, e.g. "238222" or "minecraft/mc-mods/jei"'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project }) => {
      try {
        const data = await cfwidget.getProject(project);
        return success(formatProject(data));
      } catch (e) {
        return error(`get_project: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "search_author",
    {
      title: "Search Author (no API key)",
      description:
        "Find a CurseForge author by username and list their projects. Works without API key via CFWidget.",
      inputSchema: {
        username: z.string().describe("Author username to search"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ username }) => {
      try {
        const data = await cfwidget.searchAuthor(username);
        const projects = data.projects || [];
        const lines = projects.map((p: any) => `[${p.id}] ${p.name}`);
        return success(`Author: ${data.username} (ID: ${data.id})\nProjects (${projects.length}):\n${lines.join("\n")}`);
      } catch (e) {
        return error(`search_author: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
