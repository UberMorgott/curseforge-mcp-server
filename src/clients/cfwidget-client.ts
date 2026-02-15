import { USER_AGENT } from "../utils/helpers.js";

const BASE = "https://api.cfwidget.com";

export class CfWidgetClient {
  private async get(path: string): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CFWidget ${res.status}: ${path}${body ? `\n${body.slice(0, 300)}` : ""}`);
    }
    return res.json();
  }

  /** Get project by numeric ID or by path (e.g. "minecraft/mc-mods/jei") */
  async getProject(idOrPath: string): Promise<any> {
    const path = idOrPath.startsWith("/") ? idOrPath : `/${idOrPath}`;
    return this.get(path);
  }

  /** Search author by username, returns author info + project list */
  async searchAuthor(username: string): Promise<any> {
    return this.get(`/author/search/${encodeURIComponent(username)}`);
  }

  /** Get author by numeric ID */
  async getAuthor(authorId: number): Promise<any> {
    return this.get(`/author/${authorId}`);
  }
}
