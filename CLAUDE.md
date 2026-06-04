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

Four API layers:
1. **Core API** (`src/clients/curseforge-client.ts`) — full mod data via `curseforge-api` npm package (requires API key)
2. **CFWidget** (`src/clients/cfwidget-client.ts`) — project/author lookup, no API key needed
3. **Upload API** (`src/clients/upload-client.ts`) — file uploads via CurseForge's official Upload API over native HTTPS (requires author token; no browser). POSTs to `https://www.curseforge.com/api/projects/{id}/upload-file` with an `X-Api-Token` header (header-only auth — token never in the URL). The `www` host is universal and context-aware to the author token's game, so it works for every game (Minecraft, WoW, Hytale, newer games) with no per-game config. `CURSEFORGE_GAME_SLUG` is an optional host override, default empty (= `www`); only set it for a game that responds only on its own subdomain — slug validated against `[a-z0-9-]`.
4. **Web API** (`src/clients/web-client.ts` → `browser-client.ts`) — comments, settings, description via a real browser (bypasses Cloudflare). **Unofficial workaround** — CurseForge has no official API for these; may break if their site changes.

Web API uses `patchright` (optional dep) — a patched-Playwright stealth fork — to launch a real browser and execute fetch() inside it. `BrowserClient` prefers patchright's **bundled Chromium** and falls back to **system Chrome** (`detectChromeExecutable`). It launches a `launchPersistentContext` against a dedicated profile at `~/.curseforge-mcp/chrome-profile` (session persists across runs, isolated from the user's own Chrome). Lazily launches on first Web API call, navigates to curseforge.com to pass CF challenge, minimizes the window via CDP, then reuses the session for all requests. Core/CFWidget/Upload tools use native HTTP — no browser needed.

Tools registered in `src/tools/` files. Server assembly in `src/server.ts`.

## Access Levels

| Level | Credentials | Tools Available |
|-------|------------|-----------------|
| Zero-config | None (just logged in browser) | `get_project`, `search_author` + all Web API tools (cookies auto-extracted) |
| Recommended | + `CURSEFORGE_API_KEY` | + 12 Core API tools (search, files, categories, etc.) |
| Full | + `CURSEFORGE_AUTHOR_TOKEN` | + 3 Upload tools (upload files, game versions) |

## Configuration

All credentials optional — stored in `.env`:
- `CURSEFORGE_API_KEY` — Core API key from https://console.curseforge.com/
- `CURSEFORGE_AUTHOR_TOKEN` — Author token for file uploads
- `CURSEFORGE_GAME_SLUG` — optional upload-host override; default **empty** = universal `https://www.curseforge.com/api` (works for every game incl. Hytale). Only set a slug (e.g. `minecraft`) for a game that responds only on its own subdomain; setting `hytale` would 404. Leave empty unless you know you need it.
- `CURSEFORGE_UPLOAD_DIR` — optional; if set, confines `upload_file` reads to this directory
- `.auth/cookies.json` — session cookies for Web API (auto-extracted from browser on startup)

## Tools (25 total)

**Core API (12)** — requires API key:
`search_mods`, `get_mod`, `get_mod_files`, `get_mod_file`, `get_mod_description`, `get_mod_changelog`, `get_download_url`, `download_mod`, `get_featured_mods`, `get_mods_batch`, `get_categories`, `get_game_versions`

**CFWidget (2)** — always available, no key needed:
`get_project`, `search_author`

**Upload API (3)** — requires author token:
`upload_file`, `get_upload_game_versions`, `get_upload_game_version_types`

**Web API (8)** — unofficial browser workaround; requires session cookies (auto-extracted) + a browser:
`cf_set_cookies`, `cf_auto_extract_cookies`, `get_comments`, `post_comment`, `delete_comment`, `get_project_settings`, `update_project_description`, `cf_fetch_page`

## Key Conventions

- **NEVER** write to stdout (console.log). Always use console.error for logging.
  Stdout is the MCP JSON-RPC transport channel.
- All tool handlers use `success()` / `error()` helpers from `src/utils/types.ts`.
- Responses are token-efficient: compact text summaries, not verbose JSON.
- Session cookies auto-extracted from browser via `@rookie-rs/api` (12+ browsers supported).
- `@rookie-rs/api` loaded via dynamic `import()` — server doesn't crash if native module unavailable.
- The `curseforge-api` library handles Core API requests. Do not reimplement.
- Upload API base URL: `https://www.curseforge.com/api/...` by default (native HTTPS, `X-Api-Token` header only — no browser, no token in URL). `www` is universal/context-aware to the token's game (works for any game incl. Hytale); `CURSEFORGE_GAME_SLUG` optionally overrides the host (default empty = `www`).
- Web tier prefers patchright's bundled Chromium (`npx patchright install chromium`), falls back to system Chrome; persistent profile at `~/.curseforge-mcp/chrome-profile`.
- Setup wizard asks explicit consent before enabling the Web tier (it's the unofficial workaround).
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
