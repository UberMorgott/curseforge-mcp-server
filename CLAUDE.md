# curseforge-mcp-server

## Overview
Universal MCP server, full CurseForge platform management — any game (Minecraft, Hytale, WoW, etc.).
26 tools: search mods, download/upload files, manage comments, project settings.
Zero-config: auto-extracts browser cookies; CFWidget tools work without API key.

## Build & Run

```bash
npm install              # install dependencies
npm run build            # compile TypeScript
npm start                # run the server (stdio)
npm run dev              # dev mode with hot reload (tsx watch)
```

## Architecture

Four API layers:
1. **Core API** (`src/clients/curseforge-client.ts`) — full mod data via `curseforge-api` npm package (needs API key)
2. **CFWidget** (`src/clients/cfwidget-client.ts`) — project/author lookup, no API key
3. **Upload API** (`src/clients/upload-client.ts`) — file uploads via official Upload API over native HTTPS (needs author token; no browser). POSTs to `https://www.curseforge.com/api/projects/{id}/upload-file` with `X-Api-Token` header (token never in URL). Host always `www` (works for every game incl. Hytale; `hytale.curseforge.com` 301/404). Game versions per game: `/api/game/{slug}/versions`; version types from Core API (needs API key).
4. **Web API** (`src/clients/web-client.ts` → `browser-client.ts`) — comments, settings, description via real browser (bypasses Cloudflare). **Unofficial workaround** — no official API; may break if site changes.

Web API uses `patchright` (optional dep, patched-Playwright stealth fork): launches real browser, runs fetch() inside. `BrowserClient` prefers patchright's **bundled Chromium**, falls back to **system Chrome** (`detectChromeExecutable`). `launchPersistentContext` with dedicated profile `~/.curseforge-mcp/chrome-profile` (session persists, isolated from user's Chrome). Lazy-launches on first Web API call, navigates to curseforge.com to pass CF challenge, minimizes window via CDP, reuses session. Core/CFWidget/Upload use native HTTP — no browser.

Tools registered in `src/tools/` files. Server assembly in `src/server.ts`.

## Access Levels

| Level | Credentials | Tools Available |
|-------|------------|-----------------|
| Zero-config | None (logged-in browser) | `get_project`, `search_author` + all Web API tools (cookies auto-extracted) |
| Recommended | + `CURSEFORGE_API_KEY` | + 12 Core API tools (search, files, categories, etc.) |
| Full | + `CURSEFORGE_AUTHOR_TOKEN` | + 3 Upload tools (upload files, game versions) |

## Configuration

All credentials optional, stored in `.env`:
- `CURSEFORGE_API_KEY` — Core API key from https://console.curseforge.com/
- `CURSEFORGE_AUTHOR_TOKEN` — author token for file uploads
- `CURSEFORGE_GAME_SLUG` — optional default game slug (e.g. "hytale", "minecraft") for `get_upload_game_versions` / `get_upload_game_version_types` when `game_slug` omitted. Not a host — upload host always `www.curseforge.com`. Validated `[a-z0-9-]`.
- `CURSEFORGE_UPLOAD_DIR` — optional; if set, confines `upload_file` reads to this directory
- `.auth/cookies.json` — Web API session cookies (auto-extracted from browser on startup)

## Tools (26 total)

**Core API (12)** — needs API key:
`search_mods`, `get_mod`, `get_mod_files`, `get_mod_file`, `get_mod_description`, `get_mod_changelog`, `get_download_url`, `download_mod`, `get_featured_mods`, `get_mods_batch`, `get_categories`, `get_game_versions`

**CFWidget (2)** — always available, no key:
`get_project`, `search_author`

**Upload API (3)** — needs author token:
`upload_file`, `get_upload_game_versions`, `get_upload_game_version_types`

**Web API (9)** — unofficial browser workaround; needs session cookies (auto-extracted) + browser:
`cf_set_cookies`, `cf_auto_extract_cookies`, `get_comments`, `post_comment`, `delete_comment`, `get_project_settings`, `update_project_description`, `update_project_links`, `cf_fetch_page`

## Key Conventions

- **NEVER** write to stdout (console.log). Log via console.error only.
  Stdout = MCP JSON-RPC transport channel.
- All tool handlers use `success()` / `error()` helpers from `src/utils/types.ts`.
- Responses token-efficient: compact text summaries, not verbose JSON.
- Session cookies auto-extracted from browser via `@rookie-rs/api` (12+ browsers).
- `@rookie-rs/api` loaded via dynamic `import()` — server no crash if native module unavailable.
- `curseforge-api` library handles Core API requests. Don't reimplement.
- Upload API base URL: `https://www.curseforge.com/api/...` (native HTTPS, `X-Api-Token` header only — no browser, no token in URL).
- Web tier prefers patchright's bundled Chromium (`npx patchright install chromium`), falls back to system Chrome; persistent profile `~/.curseforge-mcp/chrome-profile`.
- Setup wizard asks explicit consent before enabling Web tier (unofficial workaround).
- Use `zod/v4` for all schemas: `import { z } from "zod/v4"`
- All tools MUST have `annotations` (readOnlyHint, destructiveHint, idempotentHint, openWorldHint).

## Adding New Tools

1. Register tool in matching `src/tools/*.ts` file
2. Use `server.registerTool()` with zod input schemas + `annotations`
3. Wrap handler in try/catch, use `success()`/`error()` helpers
4. Format responses with compact formatters from `src/utils/helpers.ts`
5. Rebuild: `npm run build`

## Cross-Platform Notes

- Cookie extraction uses dynamic `import()` for `@rookie-rs/api` — graceful fallback if native module unavailable
- `src/setup.ts` uses platform-aware URL opener (win32/darwin/linux)
- User-Agent auto-detects OS via `process.platform`
- Package npm-publishable: `npm publish --access public`

## Testing

```bash
npx @modelcontextprotocol/inspector node build/index.js
```
