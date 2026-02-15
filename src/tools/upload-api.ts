import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { UploadApiClient } from "../clients/upload-client.js";
import { success, error } from "../utils/types.js";
import type { UploadMetadata } from "../utils/types.js";

export function registerUploadApiTools(
  server: McpServer,
  client: UploadApiClient,
): void {
  server.registerTool(
    "upload_file",
    {
      title: "Upload Mod File",
      description:
        "Upload a mod file to a CurseForge project. Requires CURSEFORGE_AUTHOR_TOKEN.",
      inputSchema: {
        project_id: z.number().describe("CurseForge project ID"),
        file_path: z.string().describe("Absolute path to the file to upload"),
        changelog: z.string().optional().describe("Changelog text"),
        changelog_type: z
          .enum(["text", "html", "markdown"])
          .optional()
          .default("markdown"),
        display_name: z.string().optional().describe("Display name for the file"),
        game_version_ids: z
          .array(z.number())
          .optional()
          .describe("Array of game version IDs (get from get_upload_game_versions). Optional for some games."),
        release_type: z
          .enum(["alpha", "beta", "release"])
          .default("release"),
        relations: z
          .array(
            z.object({
              slug: z.string(),
              type: z.enum([
                "embeddedLibrary",
                "incompatible",
                "optionalDependency",
                "requiredDependency",
                "tool",
              ]),
            }),
          )
          .optional()
          .describe("Project dependencies/relations"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const metadata: UploadMetadata = {
          changelog: params.changelog,
          changelogType: params.changelog_type,
          displayName: params.display_name,
          gameVersions: params.game_version_ids || [],
          releaseType: params.release_type,
        };

        if (params.relations && params.relations.length > 0) {
          metadata.relations = { projects: params.relations };
        }

        const result = await client.uploadFile(
          params.project_id,
          params.file_path,
          metadata,
        );

        return success(`File uploaded. File ID: ${result.id}`);
      } catch (e) {
        return error(`upload_file: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "get_upload_game_versions",
    {
      title: "Get Upload Game Versions",
      description:
        "Get available game versions for the upload form. Returns version IDs needed for upload_file.",
      inputSchema: {
        game_slug: z.string().optional().describe('Game slug (e.g. "hytale", "minecraft"). Currently unused — versions are global.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const versions = await client.getGameVersions();
        const lines = versions.map(
          (v) => `[${v.id}] ${v.name} (type: ${v.gameVersionTypeID})`,
        );
        return success(`${versions.length} game versions:\n${lines.join("\n")}`);
      } catch (e) {
        return error(`get_upload_game_versions: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "get_upload_game_version_types",
    {
      title: "Get Upload Version Types",
      description: "Get game version type categories for the upload form.",
      inputSchema: {
        game_slug: z.string().optional().describe('Game slug (e.g. "hytale", "minecraft"). Currently unused — types are global.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const types = await client.getGameVersionTypes();
        const lines = types.map((t) => `[${t.id}] ${t.name} (${t.slug})`);
        return success(`${types.length} version types:\n${lines.join("\n")}`);
      } catch (e) {
        return error(`get_upload_version_types: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "get_upload_dependencies",
    {
      title: "Get Upload Dependencies",
      description: "Get available dependency options for the upload form.",
      inputSchema: {
        game_slug: z.string().optional().describe('Game slug (e.g. "hytale", "minecraft"). Currently unused — dependencies are global.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const deps = await client.getGameDependencies();
        const lines = deps.map((d) => `[${d.id}] ${d.name} (${d.slug})`);
        return success(`${deps.length} dependencies:\n${lines.join("\n")}`);
      } catch (e) {
        return error(`get_upload_dependencies: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

}
