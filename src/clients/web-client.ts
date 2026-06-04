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
  private loginAttempted = false;

  constructor(config: Config) {
    this.config = config;
    this.browser = new BrowserClient();
    this.loadCookies();
  }

  /** Non-blocking startup: push on-disk cookies to the browser immediately, and
   *  if none are present kick off auto-extraction in the background. Cookie
   *  extraction scans multiple browser DBs and can take tens of seconds, so it
   *  must never block server startup / the MCP initialize handshake. */
  init(): void {
    this.browser.setCookies(this.cookies);
    if (!this.hasCookies()) {
      void this.autoExtractCookies().catch((e) => {
        console.error(
          `[web-client] Background cookie extraction failed: ${e instanceof Error ? e.message : e}`,
        );
      });
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
      // @rookie-rs found nothing (e.g. App-Bound Encryption on Windows Chrome 127+).
      // Fall back to the reliable in-browser login that works on any OS.
      return await this.browserLogin();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[web-client] Auto-extract failed: ${msg}`);
      return `Auto-extraction failed: ${msg}`;
    }
  }

  /** Reliable cross-OS login: drive the dedicated persistent browser. Open the
   *  CurseForge login page in it (visible), let the user sign in there, then read
   *  the session cookies straight from the browser context. Because the profile is
   *  persistent, the login survives across runs. */
  private async browserLogin(): Promise<string> {
    console.error(
      "[web-client] Opening CurseForge login in the dedicated browser window — please log in there...",
    );
    try {
      await this.browser.openLoginPage("https://www.curseforge.com/login");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Could not open the login browser: ${msg} (run: npx patchright install chromium)`;
    }

    const maxWait = 120_000;
    const pollInterval = 3_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const elapsed = Math.round((Date.now() - start) / 1000);

      const cookies = await this.browser.getCookies();
      const hasAuth = cookies.some(
        (c) => c.name === "SiteUserToken" || c.name === "User" || c.name === "SiteSID",
      );
      if (hasAuth) {
        console.error(`[web-client] Login detected after ${elapsed}s! Applying cookies...`);
        this.cookies = cookies;
        this.browser.setCookies(cookies);
        this.saveCookies();

        // Reset latch so a future 401 (expired cookies) can re-trigger login
        this.loginAttempted = false;

        await this.browser.refreshPages();
        return `Logged in, ${cookies.length} cookies saved`;
      }
      console.error(`[web-client] Waiting for login... (${elapsed}s)`);
    }

    return "Login timed out (2 min)";
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

    try {
      return await this.browser.request(url, method, body, headers);
    } catch (err: any) {
      // On 401, try login flow once then retry
      if (err?.message?.includes("HTTP 401") && !this.loginAttempted) {
        await this.loginFlow();
        return this.browser.request(url, method, body, headers);
      }
      throw err;
    }
  }

  private hasAuthCookie(): boolean {
    return this.cookies.some((c) =>
      c.name === "SiteUserToken" || c.name === "User" || c.name === "SiteSID",
    );
  }

  private async loginFlow(): Promise<void> {
    this.loginAttempted = true;
    const result = await this.browserLogin();
    console.error(`[web-client] ${result}`);
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
