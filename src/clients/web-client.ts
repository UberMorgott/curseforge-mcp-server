import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { CookieEntry } from "../utils/types.js";
import { USER_AGENT } from "../utils/helpers.js";
import { CookieExtractor } from "./cookie-extractor.js";

export class WebClient {
  private cookies: CookieEntry[] = [];
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.loadCookies();
  }

  async init(): Promise<void> {
    if (!this.hasCookies()) {
      await this.autoExtractCookies();
    }
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
    this.saveCookies();
  }

  setCookiesFromString(cookieString: string): void {
    // Parse "name1=value1; name2=value2" format
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
    this.saveCookies();
  }

  private saveCookies(): void {
    const dir = path.dirname(this.config.cookiesPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.config.cookiesPath, JSON.stringify(this.cookies, null, 2));
  }

  private getCookieHeader(): string {
    return this.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private getXsrfToken(): string | undefined {
    const xsrf = this.cookies.find(
      (c) => c.name.toUpperCase() === "XSRF-TOKEN" || c.name.toUpperCase() === "X-XSRF-TOKEN",
    );
    return xsrf?.value;
  }

  private browserHeaders(targetUrl: string, extra?: Record<string, string>): Record<string, string> {
    // Auto-detect Origin/Referer from the target URL
    let origin: string;
    try {
      const u = new URL(targetUrl);
      origin = u.origin;
    } catch {
      origin = "https://www.curseforge.com";
    }
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Cookie: this.getCookieHeader(),
      Accept: "application/json",
      Origin: origin,
      Referer: `${origin}/`,
      ...extra,
    };
    const xsrf = this.getXsrfToken();
    if (xsrf) {
      headers["X-XSRF-TOKEN"] = xsrf;
    }
    return headers;
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
    const headers = this.browserHeaders(url, {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    });
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${url}${errorBody ? `\n${errorBody.slice(0, 500)}` : ""}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
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
}
