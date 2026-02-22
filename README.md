# curseforge-mcp-server

Universal MCP server for full CurseForge platform management. Search mods, upload files, manage comments, edit descriptions — works with any game (Minecraft, Hytale, WoW, etc.).

25 tools across 4 API layers. Zero-config mode available — just have CurseForge open in your browser.

## Requirements

- **Node.js** >= 18
- **Chrome or Chromium** — required for Web API tools (comments, settings, description). The server uses your installed Chrome to bypass Cloudflare protection. Core API and CFWidget tools work without Chrome.
- **Desktop OS with display** (Windows, macOS, Linux with GUI) — Chrome runs in headed mode (minimized window). Headless servers (VPS, Docker) need [xvfb](https://en.wikipedia.org/wiki/Xvfb) installed.

> **Note:** The server launches a **separate Chrome instance** with its own profile — it does not interfere with your running browser. If you only use Core API tools (search, files, categories), Chrome is never launched.

## Quick Install

### 1. Setup (interactive wizard)

```bash
npx -y github:UberMorgott/curseforge-mcp-server --setup
```

The wizard will:
- Auto-extract session cookies from your browser
- Ask for API Key (opens [console.curseforge.com](https://console.curseforge.com/#/api-keys)) — or skip
- Ask for Author Token (opens [curseforge.com/account/api-tokens](https://www.curseforge.com/account/api-tokens)) — or skip
- Show how many tools are available with your config

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
| **Zero-config** | Just a CurseForge session in your browser | 2 CFWidget tools + 8 Web API tools (comments, description, settings) |
| **Recommended** | + `CURSEFORGE_API_KEY` | + 12 Core API tools (search, files, categories) |
| **Full** | + `CURSEFORGE_AUTHOR_TOKEN` | + 3 Upload tools (upload files, manage versions) |

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

### Web API (8) — requires Chrome + session cookies

These tools use a real Chrome browser to bypass Cloudflare protection on curseforge.com. Chrome launches automatically on first use (minimized window) and stays running for the session.

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
| `CURSEFORGE_GAME_SLUG` | No | Default game slug for upload API (e.g. `hytale`, `minecraft`) |

## How it works

The server uses four API layers:

1. **Core API** — Full mod data via `curseforge-api` npm package (direct HTTP)
2. **CFWidget** — Project/author lookup, zero-config fallback (direct HTTP)
3. **Upload API** — File uploads via CurseForge author endpoints (direct HTTP)
4. **Web API** — Comments, description editing, project settings via Chrome browser

### Why Chrome?

CurseForge uses Cloudflare protection that blocks all automated HTTP requests (including curl, fetch, and even TLS-fingerprint-matched requests). The only reliable way to access the Web API is through a real browser that can solve Cloudflare's JavaScript challenge.

The server uses [`puppeteer-real-browser`](https://github.com/AugmentedBeing/puppeteer-real-browser) to launch Chrome in a way that passes Cloudflare detection. Chrome is only started when a Web API tool is first called, and the session is reused for all subsequent requests. The Cloudflare challenge typically resolves in ~1 second.

Session cookies are auto-extracted from your browser via `@rookie-rs/api` (supports 12+ browsers on Windows, macOS, and Linux) and injected into the Chrome instance for authenticated requests.

### Headless servers (VPS, Docker)

On Linux servers without a display, install xvfb:

```bash
# Debian/Ubuntu
sudo apt-get install xvfb

# Arch/CachyOS
sudo pacman -S xorg-server-xvfb
```

`puppeteer-real-browser` will use xvfb automatically if no display is available.

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
