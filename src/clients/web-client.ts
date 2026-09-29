import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { CookieEntry } from "../utils/types.js";
import { CookieExtractor, type ExtractionResult } from "./cookie-extractor.js";
import { BrowserClient } from "./browser-client.js";

/** The BrowserClient surface WebClient uses (test seam). */
export type WebBrowser = Pick<BrowserClient, "setCookies" | "getCookies" | "openLoginPage" | "close" | "request" | "clearSession">;

/** Where the stored session came from: an installed browser's cookie store, the visible
 *  sign-in window, cf_set_cookies, or unknown (legacy cookies file without a sidecar). */
export type SessionSource = "browser" | "window" | "manual" | null;

/** Sidecar next to the cookies file (`session.json`); survives restarts. */
interface SessionMeta {
  source: SessionSource;
  browser: string | null;
  /** Set by logout: startup must not silently re-extract browser cookies. */
  signedOut: boolean;
}

/** Optional dependencies, overridable in tests (no real browser / network). */
export interface WebClientDeps {
  browser?: WebBrowser;
  extract?: () => Promise<ExtractionResult>;
  loginPollMs?: number;
  loginMaxWaitMs?: number;
}

export interface AutoExtractResult {
  message: string;
  /** Session check result right after extraction (false when the login window was opened instead). */
  loggedIn: boolean;
}

export class WebClient {
  private cookies: CookieEntry[] = [];
  private config: Config;
  private browser: WebBrowser;
  private extract: () => Promise<ExtractionResult>;
  private loginPollMs: number;
  private loginMaxWaitMs: number;
  private loginAttempted = false;
  private loginPolling = false;
  /** Bumped by logout so a running login poll stops without saving. */
  private loginGeneration = 0;
  private loginTask: Promise<void> | null = null;
  private meta: SessionMeta = { source: null, browser: null, signedOut: false };

  constructor(config: Config, deps: WebClientDeps = {}) {
    this.config = config;
    this.browser = deps.browser ?? new BrowserClient();
    this.extract = deps.extract ?? (() => new CookieExtractor().extractCookies());
    this.loginPollMs = deps.loginPollMs ?? 3_000;
    // Generous: users with 2FA / Google sign-in need several minutes.
    this.loginMaxWaitMs = deps.loginMaxWaitMs ?? 600_000;
    this.loadCookies();
    this.loadMeta();
  }

  /** True while the visible login window is open and being polled for a session. */
  get loginInProgress(): boolean {
    return this.loginPolling;
  }

  /** Origin of the stored session (null when no cookies are stored or it is unknown). */
  get sessionSource(): SessionSource {
    return this.hasCookies() ? this.meta.source : null;
  }

  /** Browser the cookies were extracted from, when the source is "browser". */
  get sessionBrowser(): string | null {
    return this.sessionSource === "browser" ? this.meta.browser : null;
  }

  /** True after logout until the next explicit sign-in (auto-extract / set cookies / window). */
  get signedOut(): boolean {
    return this.meta.signedOut;
  }

  private get metaPath(): string {
    return path.join(path.dirname(this.config.cookiesPath), "session.json");
  }

  private loadMeta(): void {
    if (!existsSync(this.metaPath)) return;
    try {
      const m = JSON.parse(readFileSync(this.metaPath, "utf-8"));
      const source = ["browser", "window", "manual"].includes(m?.source) ? (m.source as SessionSource) : null;
      this.meta = { source, browser: typeof m?.browser === "string" ? m.browser : null, signedOut: m?.signedOut === true };
    } catch {
      // unreadable sidecar = unknown source
    }
  }

  private saveMeta(meta: SessionMeta): void {
    this.meta = meta;
    const dir = path.dirname(this.metaPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
  }

  /** Persist cookies together with where they came from (clears the signed-out marker). */
  private saveSession(source: Exclude<SessionSource, null>, browser: string | null = null): void {
    this.saveCookies();
    this.saveMeta({ source, browser: source === "browser" ? browser : null, signedOut: false });
  }

  /** Non-blocking startup: push on-disk cookies to the browser immediately, and
   *  if none are present try a SILENT system-browser extraction in the background.
   *  Never opens a login window here — that would launch a browser/navigation that
   *  races with real web requests and is intrusive on every startup. Interactive
   *  login happens only via the cf_auto_extract_cookies tool or on a 401. */
  init(): void {
    this.browser.setCookies(this.cookies);
    // After an explicit logout, stay signed out until the user signs in again.
    if (!this.hasCookies() && !this.meta.signedOut) {
      void this.backgroundExtract();
    }
  }

  /** Silent @rookie-rs extraction for startup; no login window, no throw. */
  private async backgroundExtract(): Promise<void> {
    try {
      const result = await this.extract();
      if (result.cookies.length > 0) {
        this.cookies = result.cookies;
        this.browser.setCookies(result.cookies);
        this.saveSession("browser", result.browser);
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
    this.saveSession("manual");
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
    this.saveSession("manual");
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

  /** Extract system-browser cookies and keep them only if they carry a signed-in
   *  session (anonymous visit cookies don't). Otherwise restore the previous cookies
   *  and open the login window. */
  async autoExtractCookies(): Promise<AutoExtractResult> {
    // An explicit sign-in request ends the signed-out state from cf_logout.
    if (this.meta.signedOut) this.saveMeta({ ...this.meta, signedOut: false });
    try {
      const result = await this.extract();
      if (result.cookies.length > 0) {
        const previous = this.cookies;
        this.cookies = result.cookies;
        this.browser.setCookies(result.cookies);
        let status: { loggedIn: boolean; detail: string };
        try {
          status = await this.sessionStatus();
        } catch (e) {
          status = { loggedIn: false, detail: e instanceof Error ? e.message : String(e) };
        }
        if (status.loggedIn) {
          this.saveSession("browser", result.browser);
          return { message: `Extracted ${result.cookies.length} cookies from ${result.browser}`, loggedIn: true };
        }
        console.error(`[web-client] Extracted cookies from ${result.browser} are not signed in (${status.detail}); opening login.`);
        this.cookies = previous;
        this.browser.setCookies(previous);
      }
      // Nothing usable (no cookies, App-Bound Encryption on Windows Chrome 127+, or
      // an anonymous session). Fall back to the in-browser login that works on any OS.
      return { message: await this.browserLogin(), loggedIn: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[web-client] Auto-extract failed: ${msg}`);
      return { message: `Auto-extraction failed: ${msg}`, loggedIn: false };
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
    const gen = this.loginGeneration;
    const task = this.pollForLogin(gen).finally(() => {
      if (this.loginTask === task) {
        this.loginTask = null;
        this.loginPolling = false;
      }
    });
    this.loginTask = task;

    return (
      "A CurseForge login window has opened. Log in there — your session is captured " +
      "automatically once you do, and persists for future runs; then re-run your action. " +
      "If signing in is awkward, close it and use cf_set_cookies with the Cookie header " +
      "from a browser where you're already logged in."
    );
  }

  /** Background poll: watch the dedicated browser's cookies for an auth cookie
   *  after the user logs in, then persist the session. Never blocks a request. */
  private async pollForLogin(gen: number): Promise<void> {
    const maxWait = this.loginMaxWaitMs;
    const pollInterval = this.loginPollMs;
    const start = Date.now();
    const cancelled = () => gen !== this.loginGeneration;

    try {
      while (Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (cancelled()) return; // logout: the window is closed by logout itself
        const cookies = await this.browser.getCookies();
        if (cancelled()) return;
        const hasAuth = cookies.some(
          (c) => c.name === "SiteUserToken" || c.name === "User" || c.name === "SiteSID",
        );
        if (hasAuth) {
          this.cookies = cookies;
          this.browser.setCookies(cookies);
          this.saveSession("window");
          this.loginAttempted = false; // allow a future 401 to re-trigger login
          console.error(`[web-client] Login detected — ${cookies.length} cookies saved.`);
          return;
        }
      }
      console.error(`[web-client] Login wait timed out (${Math.round(maxWait / 1000)} s).`);
    } catch (e) {
      if (!cancelled()) console.error(`[web-client] Login window lost: ${e instanceof Error ? e.message : e}`);
    } finally {
      // Close the visible login window; the next request relaunches the hidden browser
      // on the same persistent profile, so the new session carries over. After logout
      // the browser belongs to logout (it may already be clearing the profile).
      if (!cancelled()) await this.browser.close();
    }
  }

  /** Sign out: stop the login window, forget the cookies (memory, cookies file, live
   *  browser profile) and persist a signed-out marker so startup does not silently
   *  re-extract browser cookies until the next explicit sign-in. Idempotent. */
  async logout(): Promise<void> {
    this.loginGeneration++;
    const task = this.loginTask;
    this.loginTask = null;
    this.loginPolling = false;
    this.loginAttempted = false;
    if (task) {
      await this.browser.close(); // closes the visible login window
      await task;
    }
    this.cookies = [];
    rmSync(this.config.cookiesPath, { force: true });
    this.saveMeta({ source: null, browser: null, signedOut: true });
    try {
      await this.browser.clearSession();
    } catch (e) {
      // No browser available = no persistent profile session to clear.
      console.error(`[web-client] Could not clear the browser profile session: ${e instanceof Error ? e.message : e}`);
    }
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
    try {
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, pollInterval));
        const cookies = await this.browser.getCookies();
        const hasAuth = cookies.some(
          (c) => c.name === "SiteUserToken" || c.name === "User" || c.name === "SiteSID",
        );
        if (hasAuth) {
          this.cookies = cookies;
          this.browser.setCookies(cookies);
          this.saveSession("window");
          console.error(`[setup] Login detected — ${cookies.length} cookies saved.`);
          return true;
        }
        console.error(`[setup] waiting for login... (${Math.round((Date.now() - start) / 1000)}s)`);
      }
      return false;
    } finally {
      // Close the visible login window; later requests use the hidden browser.
      await this.browser.close();
    }
  }

  private async request(
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    interactive = true,
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
      // `interactive: false` (format "json" callers, unattended) never opens a window.
      if (interactive && err?.message?.includes("HTTP 401") && !this.loginAttempted) {
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

  /** GET/POST that never opens the login window on 401 (it just throws "HTTP 401"). */
  async getQuiet(url: string): Promise<any> {
    return this.request(url, "GET", undefined, undefined, false);
  }

  async postQuiet(url: string, body?: unknown): Promise<any> {
    return this.request(url, "POST", body, undefined, false);
  }

  /** Session check as the site does it on every page: GET /api/v1/users/profile
   *  (200 + userId when signed in). Never opens a login window. */
  async sessionStatus(): Promise<{ loggedIn: boolean; user: { id: number | null; displayName: string | null; username: string | null } | null; detail: string }> {
    if (!this.hasCookies()) return { loggedIn: false, user: null, detail: "no session cookies" };
    try {
      const p = await this.getQuiet("https://www.curseforge.com/api/v1/users/profile");
      if (p && typeof p === "object" && p.userId) {
        return { loggedIn: true, user: { id: Number(p.userId), displayName: p.displayName ?? null, username: p.userName ?? null }, detail: "session valid" };
      }
      return { loggedIn: false, user: null, detail: "profile has no user (signed out)" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("HTTP 401")) return { loggedIn: false, user: null, detail: "HTTP 401 (session expired)" };
      throw e;
    }
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
