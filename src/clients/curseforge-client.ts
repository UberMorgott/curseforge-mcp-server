import { CurseForgeClient } from "curseforge-api";
import type { Config } from "../config.js";

/** Remove keys with undefined values — curseforge-api spreads options into
 *  query params via Object.entries, so undefined becomes the literal string
 *  "undefined" in the URL and the API returns 400. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Map user-friendly sort field names to CurseForgeModsSearchSortField enum values. */
const SORT_FIELD_MAP: Record<string, number> = {
  featured: 1,
  popularity: 2,
  lastupdated: 3,
  name: 4,
  author: 5,
  totaldownloads: 6,
  category: 7,
  gameversion: 8,
  earlyaccess: 9,
  featuredreleased: 10,
  releaseddate: 11,
  rating: 12,
};

export class CoreApiClient {
  private client: CurseForgeClient;
  private apiKey: string;

  constructor(config: Config) {
    if (!config.curseforgeApiKey) {
      throw new Error("CURSEFORGE_API_KEY is required for Core API access");
    }
    this.apiKey = config.curseforgeApiKey;
    this.client = new CurseForgeClient(this.apiKey);
  }

  async searchMods(
    gameId: number,
    options: {
      searchFilter?: string;
      slug?: string;
      categoryId?: number;
      classId?: number;
      gameVersion?: string;
      modLoaderType?: number;
      sortField?: string | number;
      sortOrder?: string;
      index?: number;
      pageSize?: number;
    },
  ) {
    // Resolve sortField: accept both numeric enum and string name
    let sortField: number | undefined;
    if (typeof options.sortField === "number") {
      sortField = options.sortField;
    } else if (typeof options.sortField === "string") {
      sortField = SORT_FIELD_MAP[options.sortField.toLowerCase()];
    }

    return this.client.searchMods(gameId, stripUndefined({
      searchFilter: options.searchFilter,
      slug: options.slug,
      categoryId: options.categoryId,
      classId: options.classId,
      gameVersion: options.gameVersion,
      modLoaderType: options.modLoaderType as any,
      sortField: sortField as any,
      sortOrder: options.sortOrder as any,
      index: options.index,
      pageSize: options.pageSize,
    }));
  }

  async getMod(modId: number) {
    return this.client.getMod(modId);
  }

  async getModFiles(
    modId: number,
    options?: {
      gameVersion?: string;
      modLoaderType?: number;
      index?: number;
      pageSize?: number;
    },
  ) {
    return this.client.getModFiles(modId, stripUndefined({
      gameVersion: options?.gameVersion,
      modLoaderType: options?.modLoaderType as any,
      index: options?.index,
      pageSize: options?.pageSize,
    }));
  }

  async getModDescription(
    modId: number,
    raw?: boolean,
  ): Promise<string> {
    return this.client.getModDescription(modId, stripUndefined({ raw }));
  }

  async getCategories(
    gameId: number,
    classId?: number,
  ) {
    return this.client.getCategories(gameId, stripUndefined({ classId }));
  }

  async getGames() {
    return this.client.getGames();
  }

  async getGame(gameId: number) {
    return this.client.getGame(gameId);
  }

  async getModFileChangelog(modId: number, fileId: number): Promise<string> {
    return this.client.getModFileChangelog(modId, fileId);
  }

  async getModFileDownloadURL(modId: number, fileId: number): Promise<string> {
    return this.client.getModFileDownloadURL(modId, fileId);
  }

  async getModFile(modId: number, fileId: number) {
    return this.client.getModFile(modId, fileId);
  }

  async getMods(modIds: number[]) {
    return this.client.getMods(modIds);
  }

  async getFeaturedMods(gameId: number) {
    return this.client.getFeaturedMods({
      gameId,
      excludedModIds: [],
      gameVersionTypeId: null,
    });
  }
}
