import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { CookieEntry } from "../utils/types.js";
import { CookieExtractor } from "./cookie-extractor.js";
import { BrowserClient } from "./browser-client.js";

export class WebClient {
  private cookies: CookieEntry[] = [];
  private config: Config;
  private browser: BrowserClient;

  constructor(config: Config) {
    this.config = config;
    this.browser = new BrowserClient();
    this.loadCookies();
  }

  async init(): Promise<void> {
    if (!this.hasCookies()) {
      await this.autoExtractCookies();
    }
    this.browser.setCookies(this.cookies);
  }

  private loadCookies(): void {
    if (existsSync(this.config.cookiesPath)) {
      try {
        const data = readFileSync(this.config.cookiesPath, "utf-8");
        this.cookies = JSON.parse(data);
      } catch {
        this.cookies = [];
      }
    }
  }

  setCookies(cookies: CookieEntry[]): void {
    this.cookies = cookies;
    this.browser.setCookies(cookies);
    this.saveCookies();
  }

  setCookiesFromString(cookieString: string): void {
    const entries: CookieEntry[] = cookieString
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const eqIdx = c.indexOf("=");
        if (eqIdx === -1) return null;
        return {
          name: c.slice(0, eqIdx).trim(),
          value: c.slice(eqIdx + 1).trim(),
          domain: ".curseforge.com",
          path: "/",
        };
      })
      .filter((c): c is CookieEntry => c !== null);

    this.cookies = entries;
    this.browser.setCookies(entries);
    this.saveCookies();
  }

  private saveCookies(): void {
    const dir = path.dirname(this.config.cookiesPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.config.cookiesPath, JSON.stringify(this.cookies, null, 2));
  }

  private getXsrfToken(): string | undefined {
    const xsrf = this.cookies.find(
      (c) => c.name.toUpperCase() === "XSRF-TOKEN" || c.name.toUpperCase() === "X-XSRF-TOKEN",
    );
    return xsrf?.value;
  }

  hasCookies(): boolean {
    return this.cookies.length > 0;
  }

  async autoExtractCookies(): Promise<string> {
    try {
      const extractor = new CookieExtractor();
      const result = await extractor.extractCookies();
      if (result.cookies.length > 0) {
        this.cookies = result.cookies;
        this.browser.setCookies(result.cookies);
        this.saveCookies();
        return `Extracted ${result.cookies.length} cookies from ${result.browser}`;
      }
      return result.error || "No cookies found";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[web-client] Auto-extract failed: ${msg}`);
      return `Auto-extraction failed: ${msg}`;
    }
  }

  private async request(
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<any> {
    const xsrf = this.getXsrfToken();
    const headers: Record<string, string> = {
      ...(xsrf ? { "X-XSRF-TOKEN": xsrf } : {}),
      ...extraHeaders,
    };
    return this.browser.request(url, method, body, headers);
  }

  async get(url: string, extraHeaders?: Record<string, string>): Promise<any> {
    return this.request(url, "GET", undefined, extraHeaders);
  }

  async post(
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<any> {
    return this.request(url, "POST", body, extraHeaders);
  }

  async put(
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<any> {
    return this.request(url, "PUT", body, extraHeaders);
  }

  async delete(
    url: string,
    extraHeaders?: Record<string, string>,
  ): Promise<any> {
    return this.request(url, "DELETE", undefined, extraHeaders);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
