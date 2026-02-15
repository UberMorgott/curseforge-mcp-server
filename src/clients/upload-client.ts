import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { UploadMetadata } from "../utils/types.js";
import { USER_AGENT } from "../utils/helpers.js";

const BASE_URL = "https://www.curseforge.com";

export class UploadApiClient {
  private token: string;

  constructor(config: Config) {
    if (!config.curseforgeAuthorToken) {
      throw new Error("CURSEFORGE_AUTHOR_TOKEN is required for Upload API");
    }
    this.token = config.curseforgeAuthorToken;
  }

  private headers(): Record<string, string> {
    return {
      "X-Api-Token": this.token,
      "User-Agent": USER_AGENT,
    };
  }

  async getGameVersions(): Promise<
    Array<{ id: number; gameVersionTypeID: number; name: string; slug: string }>
  > {
    const res = await fetch(`${BASE_URL}/api/game/versions`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Upload API error ${res.status} at ${res.url}`);
    return res.json();
  }

  async getGameVersionTypes(): Promise<
    Array<{ id: number; name: string; slug: string }>
  > {
    const res = await fetch(`${BASE_URL}/api/game/version-types`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Upload API error ${res.status} at ${res.url}`);
    return res.json();
  }

  async uploadFile(
    projectId: number,
    filePath: string,
    metadata: UploadMetadata,
  ): Promise<{ id: number }> {
    const fileBuffer = readFileSync(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append("metadata", JSON.stringify(metadata));
    formData.append("file", new Blob([fileBuffer]), fileName);

    const res = await fetch(
      `${BASE_URL}/api/projects/${projectId}/upload-file`,
      {
        method: "POST",
        headers: {
          "X-Api-Token": this.token,
          "User-Agent": USER_AGENT,
        },
        body: formData,
      },
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Upload failed (${res.status}): ${errorText}`);
    }

    return res.json();
  }

}
