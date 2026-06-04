# curseforge-mcp-server

Universal MCP server for full CurseForge platform management. Search mods, upload files, manage comments, edit descriptions — works with any game (Minecraft, Hytale, WoW, etc.).

25 tools across 4 API layers. Zero-config mode available — just have CurseForge open in your browser.

## Requirements

- **Node.js** >= 18
- **Chrome or Chromium** — required **only** for the Web API tools (comments, settings, description), which bypass Cloudflare protection via a real browser. The Core API, CFWidget, and Upload tools are all native HTTP and never launch a browser. Recommended: install patchright's bundled Chromium with `npx patchright install chromium`; the server falls back to your system Chrome if the bundled browser isn't present.
- **Desktop OS with display** (Windows, macOS, Linux with GUI) — for the Web tier only, the browser runs in headed mode (minimized window). On headless Linux servers (VPS, Docker) you must provide a display yourself, e.g. run under [`xvfb-run`](https://en.wikipedia.org/wiki/Xvfb) — `patchright` does **not** start xvfb automatically (see [Headless servers](#headless-servers-vps-docker)).

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

## Tools (25)

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
| `get_upload_game_versions` | Get version IDs for upload form |
| `get_upload_game_version_types` | Get version type categories |

### Web API (8) — requires a browser + session cookies (unofficial workaround)

These tools have no official CurseForge API. They use a real browser (patchright's bundled Chromium, or your system Chrome as fallback) to bypass Cloudflare protection on curseforge.com. The browser launches automatically on first use (minimized window) and stays running for the session. This is an unofficial workaround and may break if CurseForge changes their site.

| Tool | Description |
|------|-------------|
| `cf_set_cookies` | Set session cookies manually |
| `cf_auto_extract_cookies` | Auto-extract cookies from browser |
| `get_comments` | Read threaded comments on a project |
| `post_comment` | Post a comment or reply |
| `delete_comment` | Delete a comment |
| `get_project_settings` | Get project settings/metadata via Authors API |
| `update_project_description` | Update project description (HTML) |
| `cf_fetch_page` | Raw request to any CurseForge API endpoint |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSEFORGE_API_KEY` | No | Core API key from [console.curseforge.com](https://console.curseforge.com/) |
| `CURSEFORGE_AUTHOR_TOKEN` | No | Author token for file uploads |
| `CURSEFORGE_GAME_SLUG` | No | Optional override for the upload API host subdomain. **Leave empty** (the default) — uploads then use the universal `https://www.curseforge.com/api` host, which is context-aware to your author token's game and works for every game (including newer ones like Hytale, which has no dedicated subdomain). Only set a slug (e.g. `minecraft`) for the rare game that responds *only* on its own subdomain; setting it for a game without one (e.g. `hytale`) would 404. |
| `CURSEFORGE_UPLOAD_DIR` | No | If set, confines `upload_file` reads to this directory |

## How it works

The server uses four API layers:

1. **Core API** — Full mod data via `curseforge-api` npm package (direct HTTP). Official CurseForge API.
2. **CFWidget** — Project/author lookup, zero-config fallback (direct HTTP)
3. **Upload API** — File uploads via CurseForge's official Upload API (direct HTTPS, no browser). Posts to `https://www.curseforge.com/api/projects/{id}/upload-file` with an `X-Api-Token` header (the token is never placed in the URL). The `www` host is universal and context-aware to your author token's game, so the same host works for every game — Minecraft, WoW, Hytale, and any newer game — with no per-game configuration. `CURSEFORGE_GAME_SLUG` is an optional override of this host (see Environment Variables) and should normally be left empty.
4. **Web API** — Comments, description editing, project settings via a real browser (unofficial workaround)

> **Any game, including Hytale.** Reading works via the Core API (Hytale is an approved game, `gameId` 70216, slug `hytale`) and uploading works via the universal `www` host — both with no game-specific configuration. Just leave `CURSEFORGE_GAME_SLUG` empty.

### Why a browser for the Web tier?

CurseForge uses Cloudflare protection that blocks all automated HTTP requests (including curl, fetch, and even TLS-fingerprint-matched requests). CurseForge has no official API for comments, project settings, or description editing, so the only reliable way to reach those endpoints is through a real browser that can solve Cloudflare's JavaScript challenge. **This applies only to the Web tier** — the Core, CFWidget, and Upload tiers use plain HTTP and never touch a browser.

The server uses [`patchright`](https://www.npmjs.com/package/patchright) — a patched fork of Playwright that strips automation fingerprints (`--enable-automation`, `navigator.webdriver`, etc.) for stealth. It prefers patchright's **bundled Chromium** (install once with `npx patchright install chromium`) and falls back to your **system Chrome** if the bundled browser isn't present. It runs against a dedicated **persistent profile** at `~/.curseforge-mcp/chrome-profile`, so the logged-in CurseForge session survives across runs and stays isolated from your own Chrome (both can run at the same time). The browser is launched headed (the window is minimized via CDP once the challenge is solved) and is only started when a Web API tool is first called; the session is reused for all subsequent requests. The Cloudflare challenge typically resolves within a few seconds.

Session cookies can be auto-extracted from your browser via `@rookie-rs/api` (supports 12+ browsers on Windows, macOS, and Linux) and injected into the browser instance for authenticated requests.

> **Windows caveat:** Automatic cookie extraction from Chrome 127+ often fails because of App-Bound Encryption. The recommended path is the persistent-profile login — just log in to CurseForge once in the dedicated browser window the server opens, and the session persists — or supply cookies directly via the `cf_set_cookies` tool.

### Headless servers (VPS, Docker)

Because the browser runs headed, a display is required for the Web API tools only. On Linux servers without a real display, install xvfb and run the server under a virtual one — **`patchright` does not start xvfb for you**, so this is a manual step:

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
