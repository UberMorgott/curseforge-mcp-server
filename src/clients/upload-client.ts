import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { UploadMetadata } from "../utils/types.js";
import { getUserAgent } from "../utils/helpers.js";

export class UploadApiClient {
  private token: string;
  private baseUrl: string;
  private uploadDir: string;

  constructor(config: Config) {
    if (!config.curseforgeAuthorToken) {
      throw new Error("CURSEFORGE_AUTHOR_TOKEN is required for Upload API");
    }
    this.token = config.curseforgeAuthorToken;
    this.uploadDir = config.uploadDir;
    // Validate the slug: it becomes the host of token-bearing requests, so reject
    // anything that could redirect the token to another origin.
    const slug = config.curseforgeGameSlug;
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(
        `Invalid CURSEFORGE_GAME_SLUG "${slug}" — must match [a-z0-9-] (e.g. "minecraft", "hytale").`,
      );
    }
    this.baseUrl = `https://${slug}.curseforge.com/api`;
  }

  /** Issue a request with the X-Api-Token header + User-Agent. On HTTP 403,
   *  retry once with the token passed as a ?token= query param (defensive). */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      "X-Api-Token": this.token,
      "User-Agent": getUserAgent(),
    };

    let res = await fetch(url, { ...init, headers });
    if (res.status === 403) {
      const sep = url.includes("?") ? "&" : "?";
      const retryUrl = `${url}${sep}token=${encodeURIComponent(this.token)}`;
      res = await fetch(retryUrl, { ...init, headers });
    }
    return res;
  }

  async getGameVersions(): Promise<
    Array<{ id: number; gameVersionTypeID: number; name: string; slug: string }>
  > {
    const res = await this.request(
      `${this.baseUrl}/game/versions?cache=true`,
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
