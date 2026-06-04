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
  private loginPolling = false;

  constructor(config: Config) {
    this.config = config;
    this.browser = new BrowserClient();
    this.loadCookies();
  }

  /** Non-blocking startup: push on-disk cookies to the browser immediately, and
   *  if none are present try a SILENT system-browser extraction in the background.
   *  Never opens a login window here — that would launch a browser/navigation that
   *  races with real web requests and is intrusive on every startup. Interactive
   *  login happens only via the cf_auto_extract_cookies tool or on a 401. */
  init(): void {
    this.browser.setCookies(this.cookies);
    if (!this.hasCookies()) {
      void this.backgroundExtract();
    }
  }

  /** Silent @rookie-rs extraction for startup; no login window, no throw. */
  private async backgroundExtract(): Promise<void> {
    try {
      const result = await new CookieExtractor().extractCookies();
      if (result.cookies.length > 0) {
        this.cookies = result.cookies;
        this.browser.setCookies(result.cookies);
        this.saveCookies();
        console.error(
          `[web-client] Extracted ${result.cookies.length} cookies from ${result.browser}`,
        );
      }
    } catch (e) {
      console.error(
        `[web-client] Background cookie extraction failed: ${e instanceof Error ? e.message : e}`,
      );
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

  /** Reliable cross-OS login: drive the dedicated persistent browser. Opens the
   *  CurseForge login page (visible) and returns IMMEDIATELY — an interactive login
   *  can take minutes, far longer than an MCP request timeout, so the cookie capture
   *  runs in the background. Because the profile is persistent, the login survives
   *  across runs. (If signing in is awkward, cf_set_cookies is the no-login path.) */
  private async browserLogin(): Promise<string> {
    if (this.loginPolling) {
      return "A login window is already open — finish signing in there; your session is captured automatically.";
    }
    console.error("[web-client] Opening CurseForge login in the dedicated browser window...");
    try {
      await this.browser.openLoginPage("https://www.curseforge.com/login");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Could not open the login browser: ${msg} (run: npx patchright install chromium)`;
    }

    this.loginPolling = true;
    void this.pollForLogin().finally(() => {
      this.loginPolling = false;
    });

    return (
      "A CurseForge login window has opened. Log in there — your session is captured " +
      "automatically once you do, and persists for future runs; then re-run your action. " +
      "If signing in is awkward, close it and use cf_set_cookies with the Cookie header " +
      "from a browser where you're already logged in."
    );
  }

  /** Background poll: watch the dedicated browser's cookies for an auth cookie
   *  after the user logs in, then persist the session. Never blocks a request. */
  private async pollForLogin(): Promise<void> {
    const maxWait = 120_000;
    const pollInterval = 3_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const cookies = await this.browser.getCookies();
      const hasAuth = cookies.some(
        (c) => c.name === "SiteUserToken" || c.name === "User" || c.name === "SiteSID",
      );
      if (hasAuth) {
        this.cookies = cookies;
        this.browser.setCookies(cookies);
        this.saveCookies();
        this.loginAttempted = false; // allow a future 401 to re-trigger login
        await this.browser.refreshPages();
        console.error(`[web-client] Login detected — ${cookies.length} cookies saved.`);
        return;
      }
    }
    console.error("[web-client] Login wait timed out (2 min).");
  }

  /** Blocking interactive login for the setup wizard (NOT for MCP requests).
   *  Opens the dedicated persistent browser at the CurseForge login page and waits
   *  until the user signs in (an auth cookie appears) or the timeout elapses. Because
   *  the profile is persistent, the captured session is remembered for future runs.
   *  Lets browser.openLoginPage throw so the caller can show a patchright-install hint. */
  async loginInteractive(timeoutMs = 180000): Promise<boolean> {
    await this.browser.openLoginPage("https://www.curseforge.com/login");

    const pollInterval = 3_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const cookies = await this.browser.getCookies();
      const hasAuth = cookies.some(
        (c) => c.name === "SiteUserToken" || c.name === "User" || c.name === "SiteSID",
      );
      if (hasAuth) {
        this.cookies = cookies;
        this.browser.setCookies(cookies);
        this.saveCookies();
        console.error(`[setup] Login detected — ${cookies.length} cookies saved.`);
        return true;
      }
      console.error(`[setup] waiting for login... (${Math.round((Date.now() - start) / 1000)}s)`);
    }
    return false;
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
      // On 401, open the login window (non-blocking) and surface a clear message.
      // We can't wait for an interactive login within a single request, so the
      // caller should retry after logging in (or use cf_set_cookies).
      if (err?.message?.includes("HTTP 401") && !this.loginAttempted) {
        this.loginAttempted = true;
        const msg = await this.browserLogin();
        throw new Error(`Authentication required. ${msg}`);
      }
      throw err;
    }
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
