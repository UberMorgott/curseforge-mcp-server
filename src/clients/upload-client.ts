import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { UploadMetadata } from "../utils/types.js";
import { getUserAgent } from "../utils/helpers.js";

// www.curseforge.com is the universal upload host and works for every game
// (per-game subdomains like hytale.curseforge.com 301/404).
const BASE_URL = "https://www.curseforge.com/api";
const SLUG_RE = /^[a-z0-9-]+$/;

export class UploadApiClient {
  private token: string;
  private baseUrl = BASE_URL;
  private uploadDir: string;
  private defaultGameSlug: string;

  constructor(config: Config) {
    if (!config.curseforgeAuthorToken) {
      throw new Error("CURSEFORGE_AUTHOR_TOKEN is required for Upload API");
    }
    this.token = config.curseforgeAuthorToken;
    this.uploadDir = config.uploadDir;
    // CURSEFORGE_GAME_SLUG = default game for version lookups (not a host).
    const slug = config.curseforgeGameSlug;
    if (slug && !SLUG_RE.test(slug)) {
      throw new Error(
        `Invalid CURSEFORGE_GAME_SLUG "${slug}" — must match [a-z0-9-] (e.g. "hytale", "minecraft").`,
      );
    }
    this.defaultGameSlug = slug;
  }

  /** Issue a request authenticated with the X-Api-Token header. The token is
   *  never placed in the URL/query string (it could be logged by proxies/servers). */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      "X-Api-Token": this.token,
      "User-Agent": getUserAgent(),
    };
    return fetch(url, { ...init, headers });
  }

  // Unscoped /api/game/versions returns an arbitrary game's data (7 Days to Die),
  // so a game slug is mandatory.
  private resolveSlug(gameSlug?: string): string {
    const slug = gameSlug || this.defaultGameSlug;
    if (!slug) {
      throw new Error('game_slug is required (e.g. "hytale", "minecraft"), or set CURSEFORGE_GAME_SLUG');
    }
    if (!SLUG_RE.test(slug)) {
      throw new Error(`Invalid game_slug "${slug}" — must match [a-z0-9-]`);
    }
    return slug;
  }

  async getGameVersions(gameSlug?: string): Promise<
    Array<{ id: number; gameVersionTypeID: number; name: string; slug: string }>
  > {
    const slug = this.resolveSlug(gameSlug);
    const res = await this.request(
      `${this.baseUrl}/game/${slug}/versions?cache=true`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(`getGameVersions failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<
      Array<{ id: number; gameVersionTypeID: number; name: string; slug: string }>
    >;
  }

  async getGameVersionTypes(): Promise<
    Array<{ id: number; name: string; slug: string }>
  > {
    const res = await this.request(
      `${this.baseUrl}/game/version-types?cache=true`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(`getGameVersionTypes failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<
      Array<{ id: number; name: string; slug: string }>
    >;
  }

  async uploadFile(
    projectId: number,
    filePath: string,
    metadata: UploadMetadata,
  ): Promise<{ id: number }> {
    const resolved = path.resolve(filePath);
    if (this.uploadDir) {
      const root = path.resolve(this.uploadDir);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error("file_path escapes CURSEFORGE_UPLOAD_DIR");
      }
    }

    const buffer = readFileSync(resolved);
    const fileName = path.basename(resolved);

    const fd = new FormData();
    fd.append("metadata", JSON.stringify(metadata));
    fd.append("file", new Blob([buffer]), fileName);

    // No Content-Type header — fetch sets the multipart boundary itself.
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/upload-file`,
      { method: "POST", body: fd },
    );

    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (!res.ok) {
      if (body && (body.errorCode !== undefined || body.errorMessage)) {
        throw new Error(
          `upload-file failed (${body.errorCode}): ${body.errorMessage}`,
        );
      }
      throw new Error(`upload-file failed: HTTP ${res.status} ${text.slice(0, 500)}`);
    }

    return { id: body.id };
  }
}
