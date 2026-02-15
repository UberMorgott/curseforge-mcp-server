# curseforge-mcp-server

## Overview
Universal MCP server for full CurseForge platform management — any game (Minecraft, Hytale, WoW, etc.).
25 tools: search mods, download files, upload files, manage comments, project settings.
Zero-config: auto-extracts browser cookies, CFWidget tools work without any API key.

## Build & Run

```bash
npm install              # install dependencies
npm run build            # compile TypeScript
npm start                # run the server (stdio)
npm run dev              # dev mode with hot reload (tsx watch)
```

## Architecture

Four API layers — all via direct HTTP (no Playwright/browser):
1. **Core API** (`src/clients/curseforge-client.ts`) — full mod data via `curseforge-api` npm package (requires API key)
2. **CFWidget** (`src/clients/cfwidget-client.ts`) — project/author lookup, no API key needed
3. **Upload API** (`src/clients/upload-client.ts`) — file uploads via CurseForge author API (requires author token)
4. **Web API** (`src/clients/web-client.ts`) — comments, settings, analytics via internal CurseForge REST endpoints + session cookies (auto-extracted from browser)

Tools registered in `src/tools/` files. Server assembly in `src/server.ts`.

## Access Levels

| Level | Credentials | Tools Available |
|-------|------------|-----------------|
| Zero-config | None (just logged in browser) | `get_project`, `search_author` + all Web API tools (cookies auto-extracted) |
| Recommended | + `CURSEFORGE_API_KEY` | + 11 Core API tools (search, files, categories, etc.) |
| Full | + `CURSEFORGE_AUTHOR_TOKEN` | + 3 Upload tools (upload files, game versions) |

## Configuration

All credentials optional — stored in `.env`:
- `CURSEFORGE_API_KEY` — Core API key from https://console.curseforge.com/
- `CURSEFORGE_AUTHOR_TOKEN` — Author token for file uploads
- `CURSEFORGE_GAME_SLUG` — default game slug for upload API (e.g. "hytale", "minecraft")
- `.auth/cookies.json` — session cookies for Web API (auto-extracted from browser on startup)

## Tools (25 total)

**Core API (12)** — requires API key:
`search_mods`, `get_mod`, `get_mod_files`, `get_mod_file`, `get_mod_description`, `get_mod_changelog`, `get_download_url`, `download_mod`, `get_featured_mods`, `get_mods_batch`, `get_categories`, `get_game_versions`

**CFWidget (2)** — always available, no key needed:
`get_project`, `search_author`

**Upload API (3)** — requires author token:
`upload_file`, `get_upload_game_versions`, `get_upload_game_version_types`

**Web API (8)** — requires session cookies (auto-extracted):
`cf_set_cookies`, `cf_auto_extract_cookies`, `get_comments`, `post_comment`, `delete_comment`, `get_project_settings`, `update_project_description`, `cf_fetch_page`

## Key Conventions

- **NEVER** write to stdout (console.log). Always use console.error for logging.
  Stdout is the MCP JSON-RPC transport channel.
- All tool handlers use `success()` / `error()` helpers from `src/utils/types.ts`.
- Responses are token-efficient: compact text summaries, not verbose JSON.
- Session cookies auto-extracted from browser via `@rookie-rs/api` (12+ browsers supported).
- `@rookie-rs/api` loaded via dynamic `import()` — server doesn't crash if native module unavailable.
- The `curseforge-api` library handles Core API requests. Do not reimplement.
- Upload API base URL: `https://{gameSlug}.curseforge.com/api/...`
- Use `zod/v4` for all schema definitions: `import { z } from "zod/v4"`
- All tools MUST have `annotations` (readOnlyHint, destructiveHint, idempotentHint, openWorldHint).

## Adding New Tools

1. Add tool registration in the appropriate `src/tools/*.ts` file
2. Use `server.registerTool()` with zod input schemas and `annotations`
3. Wrap handler logic in try/catch, use `success()`/`error()` helpers
4. Use compact formatters from `src/utils/helpers.ts` for responses
5. Rebuild with `npm run build`

## Cross-Platform Notes

- Cookie extraction uses dynamic `import()` for `@rookie-rs/api` — gracefully falls back if native module unavailable
- `src/setup.ts` uses platform-aware URL opener (win32/darwin/linux)
- User-Agent string auto-detects OS via `process.platform`
- Package is npm-publishable: `npm publish --access public`

## Testing

```bash
npx @modelcontextprotocol/inspector node build/index.js
```
