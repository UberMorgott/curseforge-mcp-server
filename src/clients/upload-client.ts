import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { WebClient } from "./web-client.js";
import type { UploadMetadata } from "../utils/types.js";

const BASE_URL = "https://www.curseforge.com";

export class UploadApiClient {
  private token: string;
  private web: WebClient;

  constructor(config: Config, webClient: WebClient) {
    if (!config.curseforgeAuthorToken) {
      throw new Error("CURSEFORGE_AUTHOR_TOKEN is required for Upload API");
    }
    this.token = config.curseforgeAuthorToken;
    this.web = webClient;
  }

  async getGameVersions(): Promise<
    Array<{ id: number; gameVersionTypeID: number; name: string; slug: string }>
  > {
    return this.web.get(`${BASE_URL}/api/game/versions`, {
      "X-Api-Token": this.token,
    }) as any;
  }

  async getGameVersionTypes(): Promise<
    Array<{ id: number; name: string; slug: string }>
  > {
    return this.web.get(`${BASE_URL}/api/game/version-types`, {
      "X-Api-Token": this.token,
    }) as any;
  }

  async uploadFile(
    projectId: number,
    filePath: string,
    metadata: UploadMetadata,
  ): Promise<{ id: number }> {
    const fileBuffer = readFileSync(filePath);
    const fileName = path.basename(filePath);
    const fileBase64 = fileBuffer.toString("base64");

    return this.web.uploadFile(
      `${BASE_URL}/api/projects/${projectId}/upload-file`,
      fileBase64,
      fileName,
      JSON.stringify(metadata),
      { "X-Api-Token": this.token },
    ) as any;
  }
}
