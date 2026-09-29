# curseforge-mcp-server

Universal MCP server for full CurseForge platform management. Search mods, upload files, manage comments, edit descriptions — works with any game (Minecraft, Hytale, WoW, etc.).

26 tools across 4 API layers. Zero-config mode available — just have CurseForge open in your browser.

## Requirements

- **Node.js** >= 18
- **Chrome or Chromium** — required **only** for the Web API tools (comments, settings, description), which bypass Cloudflare protection via a real browser. The Core API, CFWidget, and Upload tools are all native HTTP and never launch a browser. Recommended: install patchright's bundled Chromium with `npx patchright install chromium`; the server falls back to your system Chrome if the bundled browser isn't present.
- **Display only for login** — for the Web tier the browser runs headless (no window) during normal tool calls; a visible window opens only for the interactive CurseForge login. On headless Linux servers (VPS, Docker) you must provide a display yourself, e.g. run under [`xvfb-run`](https://en.wikipedia.org/wiki/Xvfb) — `patchright` does **not** start xvfb automatically (see [Headless servers](#headless-servers-vps-docker)).

> **Note:** For the Web tier, the server launches a **separate, dedicated browser** with its own persistent profile at `~/.curseforge-mcp/chrome-profile` — it does not interfere with your running browser, and the two can run simultaneously. If you only use Core API, CFWidget, or Upload tools, no browser is ever launched.

> **Native vs workaround:** The Core API (search/files/etc.) and the Upload API are official CurseForge APIs. The Web API tools (comments, project settings, descriptions) have **no official API** and use an **unofficial** browser-automation workaround (session cookies + Cloudflare bypass) that may break if CurseForge changes their site.

## Quick Install

### 1. Setup (interactive wizard)

```bash
npx -y github:UberMorgott/curseforge-mcp-server --setup
```

The wizard will:
- Ask for explicit consent before enabling the Web API tier (it's the unofficial browser-automation workaround), then auto-extract session cookies from your browser
- Ask for API Key (opens [console.curseforge.com](https://console.curseforge.com/#/api-keys)) — or skip
- Ask for Author Token (opens [curseforge.com/account/api-tokens](https://www.curseforge.com/account/api-tokens)) — or skip
- Show how many tools are available with your config

> If you plan to use the Web tier, install patchright's bundled browser once: `npx patchright install chromium` (recommended; falls back to system Chrome if not installed).

### 2. Add to your AI client

#### Claude Code

```bash
claude mcp add curseforge-mcp-server -- npx -y github:UberMorgott/curseforge-mcp-server
```

### Claude Desktop

Add to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "curseforge": {
      "command": "npx",
      "args": ["-y", "github:UberMorgott/curseforge-mcp-server"],
      "env": {
        "CURSEFORGE_API_KEY": "your-key",
        "CURSEFORGE_AUTHOR_TOKEN": "your-token"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "curseforge": {
      "command": "npx",
      "args": ["-y", "github:UberMorgott/curseforge-mcp-server"],
      "env": {
        "CURSEFORGE_API_KEY": "your-key"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "curseforge": {
      "command": "npx",
      "args": ["-y", "github:UberMorgott/curseforge-mcp-server"],
      "env": {
        "CURSEFORGE_API_KEY": "your-key"
      }
    }
  }
}
```

### Manual install

```bash
git clone https://github.com/UberMorgott/curseforge-mcp-server.git
cd curseforge-mcp-server
npm install && npm run build
```

Then point your MCP client to `node /path/to/curseforge-mcp-server/build/index.js`.

## Access Levels

All credentials are optional. The server works in three tiers:

| Level | What you need | Tools available |
|-------|--------------|-----------------|
| **Zero-config** | A CurseForge session in your browser + a browser (Chrome/bundled Chromium) for the unofficial Web tier | 2 CFWidget tools + 8 Web API tools (comments, description, settings) |
| **Recommended** | + `CURSEFORGE_API_KEY` | + 12 Core API tools (search, files, categories) |
| **Full** | + `CURSEFORGE_AUTHOR_TOKEN` | + 3 Upload tools (upload files, manage versions). Native HTTP — no browser, no per-game config. Works for any game, including newer ones like Hytale. |

### Getting credentials

- **API Key**: Create at [console.curseforge.com](https://console.curseforge.com/) (free)
- **Author Token**: Get from [curseforge.com/account/api-tokens](https://www.curseforge.com/account/api-tokens)
- **Session cookies**: Auto-extracted from your browser, or set manually via the `cf_set_cookies` tool

## Tools (27)

### Core API (12) — requires API key

| Tool | Description |
|------|-------------|
| `search_mods` | Search mods by name, category, game version, mod loader |
| `get_mod` | Get full mod details by ID |
| `get_mod_files` | List files for a mod with filtering |
| `get_mod_file` | Get specific file details |
| `get_mod_description` | Get mod description (HTML or text) |
| `get_mod_changelog` | Get changelog for a file release |
| `get_download_url` | Get direct download URL |
| `download_mod` | Download a mod file to local directory |
| `get_featured_mods` | Get popular/featured/recently updated mods |
| `get_mods_batch` | Fetch multiple mods by ID in one request |
| `get_categories` | Get available mod categories |
| `get_game_versions` | List games or get game details |

### CFWidget (2) — always available, no key needed

| Tool | Description |
|------|-------------|
| `get_project` | Get project info by ID or path |
| `search_author` | Find author by username, list their projects |

### Upload API (3) — requires author token

| Tool | Description |
|------|-------------|
| `upload_file` | Upload a mod file to a project |
| `get_upload_game_versions` | Get version IDs for upload form (`game_slug`, e.g. `hytale`; defaults to `CURSEFORGE_GAME_SLUG`) |
| `get_upload_game_version_types` | Get version type categories for a game (`game_slug`; needs `CURSEFORGE_API_KEY`) |

### Web API (10) — requires a browser + session cookies (unofficial workaround)

These tools have no official CurseForge API. They use a real browser (patchright's bundled Chromium, or your system Chrome as fallback) to bypass Cloudflare protection on curseforge.com. The browser launches automatically on first use (minimized window) and stays running for the session. This is an unofficial workaround and may break if CurseForge changes their site.

| Tool | Description |
|------|-------------|
| `cf_set_cookies` | Set session cookies manually |
| `cf_auto_extract_cookies` | Sign in: silent extract from installed browsers → else login page in the default browser (if its cookie store is readable) → else the server's sign-in window |
| `cf_login_cancel` | Stop a running sign-in (default-browser polling / sign-in window) |
| `cf_session_status` | Is the stored session signed in (never opens a login window) |
| `cf_logout` | Sign out: close the login window, delete stored cookies and clear them from the browser profile; no silent re-extract at startup until the next explicit sign-in |
| `get_comments` | Read threaded comments on a project |
| `post_comment` | Post a comment or reply |
| `delete_comment` | Delete a comment |
| `get_project_settings` | Get project settings/metadata via Authors API |
| `update_project_description` | Update project description (HTML) |
| `update_project_links` | Update project Source link (GitHub/Bitbucket/other URL) |
| `cf_fetch_page` | Raw request to any CurseForge API endpoint |

## Structured output (`format: "json"`)

For programs (e.g. IssueWatcher) these tools take `format: "json"` (default `"text"`,
unchanged): `search_author`, `get_project`, `get_comments`, `post_comment`,
`cf_session_status`, `cf_auto_extract_cookies`, `cf_login_cancel`, `cf_logout`. The result is the full, untruncated object
as MCP `structuredContent`, and the same JSON in the text block. No `outputSchema` is
declared (the SDK would then demand structuredContent in text mode too); the zod schemas
live in `src/tools/json-shapes.ts` and are checked by `npm test` against saved API
responses in `test/fixtures/`. JSON-mode web calls never open the login window on 401
(they return `not_logged_in`).

Conventions: comment ids are strings; mod / user ids and counts are numbers; `*At` =
ISO-8601 UTC or `null`.

| Tool | Result |
|---|---|
| `search_author` | `{author:{id, username}, projects:[{id, name}]}` (CFWidget, keyless; unknown user → `not_found`) |
| `get_project` | `{id, title, summary, game, type, url, createdAt, downloads, members:[{id, username, title}]}` |
| `get_comments` | `{modId, page, pages, pageSize:20, total, comments:[{id, parentId:null, author, authorId, authorUsername, createdAt, updatedAt, body, bodyHtml, pinned, replies:[{id, parentId, depth, author, authorId, authorUsername, createdAt, updatedAt, body, bodyHtml}]}]}` — root threads newest first; every nested reply flattened depth-first with its `parentId` (`depth` 1 = reply to the root); 20 entries per page **counting replies**, `total` = entries; a new reply on an old thread stays on that thread's page, so a sync must walk all `pages`. `body` = site plain text, `bodyHtml` = rendered HTML; `updatedAt` = `dateEdited` |
| `post_comment` | `{posted:true, id, parentId, verified}` — `id` from the response if it has one, else read back (first 3 pages, same text + same parent, newest); `verified:false, id:null` if not found |
| `cf_session_status` | `{loggedIn, cookiesStored, user:{id, displayName, username} \| null, detail, loginInProgress, sessionSource, sessionBrowser, loginVia, loginBrowser}` — the site's own `GET /api/v1/users/profile`; never opens a login window; `loginInProgress` = the login window is still open and being watched; `sessionSource` = where the stored session came from: `"browser"` (extracted from an installed browser, incl. the silent startup extract; `sessionBrowser` = its name), `"window"` (the sign-in window), `"manual"` (`cf_set_cookies`), or `null` (no cookies / unknown legacy session). Kept in `session.json` next to `cookies.json`. `loginVia` = path of the current / last sign-in of this process: `"browser-extract"` \| `"default-browser"` \| `"window"` \| `null`; `loginBrowser` = the default browser when `"default-browser"`, else `null` |
| `cf_auto_extract_cookies` | `{result, cookiesStored, loginWindowOpened, loggedIn, loginInProgress, sessionSource, sessionBrowser, loginVia, loginBrowser}` — order: (1) extract from every installed browser, first signed-in one wins (`loginVia:"browser-extract"`); anonymous cookies are never kept; (2) else detect the default browser (Windows `UserChoice` ProgId) and, if its cookie store is readable (not Chrome 127+ app-bound), open the login page there and poll its cookies (`loginVia:"default-browser"`, success → `sessionSource:"browser"`); (3) else the server's sign-in window (`loginVia:"window"`). `loginWindowOpened` = this call started (2) or (3); `loginInProgress` stays true while it polls. Every step is logged to stderr with the `[login] ` prefix. The window waits up to 10 min for sign-in (2FA/Google), then closes; poll `cf_session_status` until `loggedIn` |
| `cf_login_cancel` | `{cancelled}` — `true` if a running sign-in was stopped (sign-in window closed) |
| `cf_logout` | `{loggedOut:true, cookiesStored:false}` — stops the login window, deletes `cookies.json`, clears curseforge.com cookies in the browser profile and marks the session signed out, so startup does not re-extract browser cookies until the next `cf_auto_extract_cookies` / `cf_set_cookies` / window sign-in. Idempotent |

Errors (`isError: true`): `structuredContent = {error:{code, message}}`, `code` ∈
`not_logged_in` (no cookies / HTTP 401), `cloudflare` (HTTP 403 after the challenge retry),
`not_found`, `disabled`, `rate_limited`, `invalid`, `outcome_unknown` (`post_comment` was
sent but failed without a 4xx refusal — 5xx, timeout, unreadable answer: it may have been
saved, read back before retrying), `error`. Writes are never retried;
browser GETs back off once on HTTP 429 (3 s).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSEFORGE_API_KEY` | No | Core API key from [console.curseforge.com](https://console.curseforge.com/) |
| `CURSEFORGE_AUTHOR_TOKEN` | No | Author token for file uploads |
| `CURSEFORGE_GAME_SLUG` | No | Default game slug (e.g. `hytale`, `minecraft`) for `get_upload_game_versions` / `get_upload_game_version_types` when `game_slug` is not passed. Not a host — uploads always use the universal `https://www.curseforge.com/api`. |
| `CURSEFORGE_UPLOAD_DIR` | No | If set, confines `upload_file` reads to this directory |
| `CURSEFORGE_BROWSER_VISIBLE` | No | Debug only: `1` shows the Web API browser window (default: headless) |

## How it works

The server uses four API layers:

1. **Core API** — Full mod data via `curseforge-api` npm package (direct HTTP). Official CurseForge API.
2. **CFWidget** — Project/author lookup, zero-config fallback (direct HTTP)
3. **Upload API** — File uploads via CurseForge's official Upload API (direct HTTPS, no browser). Posts to `https://www.curseforge.com/api/projects/{id}/upload-file` with an `X-Api-Token` header (the token is never placed in the URL). The `www` host is universal and context-aware to your author token's game, so the same host works for every game — Minecraft, WoW, Hytale, and any newer game — with no per-game configuration. Game versions are per game (`/api/game/{slug}/versions`); version types come from the Core API.
4. **Web API** — Comments, description editing, project settings via a real browser (unofficial workaround)

> **Any game, including Hytale.** Reading works via the Core API (Hytale is an approved game, `gameId` 70216, slug `hytale`) and uploading works via the universal `www` host — both with no game-specific host configuration. Pass `game_slug: "hytale"` (or set `CURSEFORGE_GAME_SLUG=hytale`) when listing upload game versions.

### Why a browser for the Web tier?

CurseForge uses Cloudflare protection that blocks all automated HTTP requests (including curl, fetch, and even TLS-fingerprint-matched requests). CurseForge has no official API for comments, project settings, or description editing, so the only reliable way to reach those endpoints is through a real browser that can solve Cloudflare's JavaScript challenge. **This applies only to the Web tier** — the Core, CFWidget, and Upload tiers use plain HTTP and never touch a browser.

The server uses [`patchright`](https://www.npmjs.com/package/patchright) — a patched fork of Playwright that strips automation fingerprints (`--enable-automation`, `navigator.webdriver`, etc.) for stealth. It prefers patchright's **bundled Chromium** (install once with `npx patchright install chromium`) and falls back to your **system Chrome** if the bundled browser isn't present. It runs against a dedicated **persistent profile** at `~/.curseforge-mcp/chrome-profile`, so the logged-in CurseForge session survives across runs and stays isolated from your own Chrome (both can run at the same time). For normal tool calls the browser runs **headless** (no window, no taskbar entry; its `HeadlessChrome` user-agent token is replaced so Cloudflare accepts it), is only started when a Web API tool is first called, and is reused for all subsequent requests. A visible window opens only for the interactive login (`cf_auto_extract_cookies` fallback, setup wizard) and is closed once you have signed in. Set `CURSEFORGE_BROWSER_VISIBLE=1` to show the browser for debugging. The Cloudflare challenge typically resolves within a few seconds.

Session cookies can be auto-extracted from your browser via `@rookie-rs/api` (supports 12+ browsers on Windows, macOS, and Linux) and injected into the browser instance for authenticated requests.

> **Windows caveat:** Automatic cookie extraction from Chrome 127+ often fails because of App-Bound Encryption. The recommended path is the persistent-profile login — just log in to CurseForge once in the dedicated browser window the server opens, and the session persists — or supply cookies directly via the `cf_set_cookies` tool.

### Headless servers (VPS, Docker)

Normal Web API calls run headless and need no display. Only the interactive login opens a visible window, so on a server either copy cookies in via `cf_set_cookies` or provide a display for that one step. On Linux servers without a real display, install xvfb and run the server under a virtual one — **`patchright` does not start xvfb for you**, so this is a manual step:

```bash
# Debian/Ubuntu
sudo apt-get install xvfb

# Arch/CachyOS
sudo pacman -S xorg-server-xvfb
```

Then wrap the server process with `xvfb-run` (or set `DISPLAY` to an X server you manage):

```bash
xvfb-run -a node build/index.js
```

Core API, CFWidget, and Upload tools use direct HTTP and need no display.

## Development

```bash
git clone https://github.com/UberMorgott/curseforge-mcp-server.git
cd curseforge-mcp-server
npm install
npm run build      # compile TypeScript
npm start          # run server (stdio)
npm run dev        # dev mode with hot reload
npm run setup      # interactive setup wizard
```

### Testing

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

## License

MIT
