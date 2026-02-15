import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { WebClient } from "../clients/web-client.js";
import { formatCommentThread, compact, truncate } from "../utils/helpers.js";
import { success, error } from "../utils/types.js";

const CF_BASE = "https://www.curseforge.com";
const AUTHORS_API = "https://authors.curseforge.com/_api";

export function registerWebApiTools(
  server: McpServer,
  client: WebClient,
): void {
  server.registerTool(
    "cf_set_cookies",
    {
      title: "Set CurseForge Session Cookies",
      description:
        'Set session cookies manually. Pass as "name1=value1; name2=value2" string.',
      inputSchema: {
        cookies: z.string().describe('Cookie string from browser'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ cookies }) => {
      try {
        client.setCookiesFromString(cookies);
        return success(`Cookies saved. Session active: ${client.hasCookies()}`);
      } catch (e) {
        return error(`set_cookies: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "cf_auto_extract_cookies",
    {
      title: "Auto-Extract Browser Cookies",
      description:
        "Automatically extract curseforge.com session cookies from installed browsers. No user input needed.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = await client.autoExtractCookies();
        return success(`${result}\nSession active: ${client.hasCookies()}`);
      } catch (e) {
        return error(`auto_extract: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "get_comments",
    {
      title: "Get Project Comments",
      description: "Read comments on a CurseForge project. Returns threaded comments with replies nested under parent comments. Comments without replies are marked [NO REPLIES].",
      inputSchema: {
        mod_id: z.number().describe("CurseForge mod/project ID"),
        page: z.number().optional().default(1),
        page_size: z.number().optional().default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ mod_id, page, page_size }) => {
      if (!client.hasCookies()) return error("No session cookies. Use cf_auto_extract_cookies first.");
      try {
        const index = (page - 1) * page_size;
        const data = await client.get(
          `${CF_BASE}/api/v1/mods/${mod_id}/comments?index=${index}&pageSize=${page_size}`,
        );
        const comments = data.data || [];
        const threads = comments.map((c: any) => formatCommentThread(c));
        const unanswered = comments.filter((c: any) => !c.replies?.length).length;
        const total = data.pagination?.totalCount || "?";
        return success(`${total} comments (page ${page}), ${unanswered} unanswered:\n\n${threads.join("\n\n")}`);
      } catch (e) {
        return error(`get_comments: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "post_comment",
    {
      title: "Post Comment",
      description: "Post a comment or reply on a CurseForge project.",
      inputSchema: {
        mod_id: z.number().describe("CurseForge mod/project ID"),
        comment_text: z.string().describe("Comment text"),
        reply_to_id: z.number().optional().describe("Comment ID to reply to"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ mod_id, comment_text, reply_to_id }) => {
      if (!client.hasCookies()) return error("No session cookies. Use cf_auto_extract_cookies first.");
      try {
        const body: Record<string, unknown> = {
          entityId: mod_id,
          body: comment_text,
          bodyType: "RawHtml",
        };
        if (reply_to_id !== undefined) body.parentCommentId = reply_to_id;
        await client.post(`${CF_BASE}/api/v1/comments`, body);
        return success("Comment posted.");
      } catch (e) {
        return error(`post_comment: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete Comment",
      description: "Delete a comment on a CurseForge project.",
      inputSchema: {
        mod_id: z.number(),
        comment_id: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ mod_id, comment_id }) => {
      if (!client.hasCookies()) return error("No session cookies. Use cf_auto_extract_cookies first.");
      try {
        await client.delete(`${CF_BASE}/api/v1/comments/${comment_id}`);
        return success(`Comment ${comment_id} deleted.`);
      } catch (e) {
        return error(`delete_comment: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "get_project_settings",
    {
      title: "Get Project Settings",
      description: "Get settings/metadata for a CurseForge project via Authors API. Returns project config, permissions, status, and more.",
      inputSchema: {
        project_id: z.number().describe("CurseForge project ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id }) => {
      if (!client.hasCookies()) return error("No session cookies. Use cf_auto_extract_cookies first.");
      try {
        const data = await client.get(`${AUTHORS_API}/projects/${project_id}`);
        return success(truncate(compact(data)));
      } catch (e) {
        return error(`get_project_settings: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "update_project_description",
    {
      title: "Update Project Description",
      description:
        "Update the description of a CurseForge project (HTML supported). Requires session cookies (browser auth).",
      inputSchema: {
        project_id: z.number().describe("CurseForge project ID"),
        description: z.string().describe("New description (HTML supported)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ project_id, description }) => {
      if (!client.hasCookies()) return error("No session cookies. Use cf_auto_extract_cookies first.");
      try {
        await client.put(
          `${AUTHORS_API}/projects/description/${project_id}`,
          { description, descriptionType: 1, id: project_id },
        );
        return success("Description updated.");
      } catch (e) {
        return error(`update_project_description: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "cf_fetch_page",
    {
      title: "Fetch CurseForge API Endpoint",
      description:
        "Make a request to any CurseForge internal API endpoint. For endpoints not covered by other tools.",
      inputSchema: {
        url: z.string().describe("Full URL or path (e.g. '/api/v1/mods/12345/members')"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
        body: z.string().optional().describe("JSON body for POST"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, method, body }) => {
      try {
        const fullUrl = url.startsWith("http") ? url : `${CF_BASE}${url}`;
        let data: any;
        if (method === "POST") {
          data = await client.post(fullUrl, body ? JSON.parse(body) : undefined);
        } else if (method === "PUT") {
          data = await client.put(fullUrl, body ? JSON.parse(body) : undefined);
        } else if (method === "DELETE") {
          data = await client.delete(fullUrl);
        } else {
          data = await client.get(fullUrl);
        }
        const text = typeof data === "string" ? data : compact(data);
        return success(truncate(text));
      } catch (e) {
        return error(`cf_fetch_page: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
