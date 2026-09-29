import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { CookieEntry } from "../utils/types.js";
import { CookieExtractor, type ExtractionResult } from "./cookie-extractor.js";
import { BrowserClient } from "./browser-client.js";
import { detectDefaultBrowser, openInDefaultBrowser, type DefaultBrowser } from "./default-browser.js";

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
  /** Every installed browser's curseforge.com cookies (or read error), in try order. */
  extractAll?: () => Promise<ExtractionResult[]>;
  /** One browser's cookies by key; `error` = its store is unreadable. */
  extractFrom?: (browser: string) => Promise<ExtractionResult>;
  detectDefaultBrowser?: () => Promise<DefaultBrowser>;
  openUrl?: (url: string) => Promise<void>;
  loginPollMs?: number;
  loginMaxWaitMs?: number;
}

/** How the current / last sign-in of this process runs: silent extraction from installed
 *  browsers, polling the user's default browser after opening the login page there, or
 *  the server's own sign-in window. */
export type LoginVia = "browser-extract" | "default-browser" | "window" | null;

export interface AutoExtractResult {
  message: string;
  /** Session check result right after extraction (false when a login was started instead). */
  loggedIn: boolean;
  /** This call opened the login page (default browser or the sign-in window). */
  loginStarted: boolean;
}

const LOGIN_URL = "https://www.curseforge.com/login";
const log = (msg: string) => console.error(`[login] ${msg}`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fingerprint = (c: CookieEntry[]) => c.map((x) => `${x.name}=${x.value}`).sort().join(";");

export class WebClient {
  private cookies: CookieEntry[] = [];
  private config: Config;
  private browser: WebBrowser;
  private extractAll: () => Promise<ExtractionResult[]>;
  private extractFrom: (browser: string) => Promise<ExtractionResult>;
  private detectDefault: () => Promise<DefaultBrowser>;
  private openUrl: (url: string) => Promise<void>;
  private via: LoginVia = null;
  private viaBrowser: string | null = null;
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
    const extractor = new CookieExtractor();
    this.extractAll = deps.extractAll ?? (() => extractor.extractAll());
    this.extractFrom = deps.extractFrom ?? ((b) => extractor.extractFrom(b));
    this.detectDefault = deps.detectDefaultBrowser ?? detectDefaultBrowser;
    this.openUrl = deps.openUrl ?? openInDefaultBrowser;
    this.loginPollMs = deps.loginPollMs ?? 3_000;
    // Generous: users with 2FA / Google sign-in need several minutes.
    this.loginMaxWaitMs = deps.loginMaxWaitMs ?? 600_000;
    this.loadCookies();
    this.loadMeta();
  }

  /** True while a started login (default browser or sign-in window) is being polled. */
  get loginInProgress(): boolean {
    return this.loginPolling;
  }

  /** Path of the current / last sign-in in this process (null = none since start / logout). */
  get loginVia(): LoginVia {
    return this.via;
  }

  /** Default browser being used, when loginVia is "default-browser". */
  get loginBrowser(): string | null {
    return this.via === "default-browser" ? this.viaBrowser : null;
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
      const result = (await this.extractAll()).find((r) => r.cookies.length > 0);
      if (result) {
        this.cookies = result.cookies;
        this.browser.setCookies(result.cookies);
        this.saveSession("browser", result.browser);
        log(`startup extract: ${result.cookies.length} cookies from ${result.browser} (source browser/${result.browser})`);
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

  /** Try cookies as the session: keep them if the site says signed in, else restore. */
  private async trySession(cookies: CookieEntry[]): Promise<{ loggedIn: boolean; detail: string }> {
    const previous = this.cookies;
    this.cookies = cookies;
    this.browser.setCookies(cookies);
    let status: { loggedIn: boolean; detail: string };
    try {
      status = await this.sessionStatus();
    } catch (e) {
      status = { loggedIn: false, detail: errMsg(e) };
    }
    if (!status.loggedIn) {
      this.cookies = previous;
      this.browser.setCookies(previous);
    }
    return status;
  }

  /** Sign-in, in this order:
   *  1. silently extract cookies from every installed browser; the first signed-in one wins;
   *  2. else, if the user's default browser's cookie store is readable, open the login page
   *     there and poll that browser's cookies until signed in (background);
   *  3. else open the server's own sign-in window (background).
   *  Anonymous cookies are never kept. Returns immediately after starting 2 or 3. */
  async autoExtractCookies(): Promise<AutoExtractResult> {
    // An explicit sign-in request ends the signed-out state from cf_logout.
    if (this.meta.signedOut) this.saveMeta({ ...this.meta, signedOut: false });
    try {
      // 1. Silent extraction.
      let results: ExtractionResult[] = [];
      try {
        results = await this.extractAll();
      } catch (e) {
        log(`extract failed: ${errMsg(e)}`);
      }
      for (const r of results) {
        if (r.error) {
          log(`extract ${r.browser}: error (${r.error})`);
          continue;
        }
        if (r.cookies.length === 0) {
          log(`extract ${r.browser}: 0 cookies`);
          continue;
        }
        const status = await this.trySession(r.cookies);
        log(`extract ${r.browser}: ${r.cookies.length} cookies, signed in: ${status.loggedIn ? "yes" : `no (${status.detail})`}`);
        if (status.loggedIn) {
          this.saveSession("browser", r.browser);
          this.via = "browser-extract";
          this.viaBrowser = null;
          log(`captured session: source browser/${r.browser}`);
          return { message: `Extracted ${r.cookies.length} cookies from ${r.browser}`, loggedIn: true, loginStarted: false };
        }
      }

      if (this.loginPolling) {
        const where = this.via === "default-browser" ? `in ${this.viaBrowser}` : "in the sign-in window";
        log(`login already in progress (${where})`);
        return { message: `A login is already in progress ${where} — finish signing in there; your session is captured automatically.`, loggedIn: false, loginStarted: false };
      }

      // 2. The user's default browser, if we can read its cookie store.
      const viaDefault = await this.defaultBrowserLogin();
      if (viaDefault) return { message: viaDefault, loggedIn: false, loginStarted: true };

      // 3. The server's own sign-in window.
      const message = await this.browserLogin();
      return { message, loggedIn: false, loginStarted: this.loginPolling };
    } catch (err) {
      log(`auto-extract failed: ${errMsg(err)}`);
      return { message: `Auto-extraction failed: ${errMsg(err)}`, loggedIn: false, loginStarted: false };
    }
  }

  /** Step 2: open the login page in the default browser and poll its cookies.
   *  Returns the user message, or null when this path does not apply. */
  private async defaultBrowserLogin(): Promise<string | null> {
    let def: DefaultBrowser;
    try {
      def = await this.detectDefault();
    } catch (e) {
      log(`default browser: detection failed (${errMsg(e)})`);
      return null;
    }
    log(`default browser: ProgId ${def.progId ?? "unknown"} -> ${def.browser ?? "unknown"}`);
    if (!def.browser) return null;
    const name = def.browser;
    const probe = await this.extractFrom(name).catch((e): ExtractionResult => ({ browser: name, cookies: [], error: errMsg(e) }));
    log(`default browser ${name}: cookie store readable: ${probe.error ? `no (${probe.error})` : "yes"}`);
    if (probe.error) return null;
    try {
      await this.openUrl(LOGIN_URL);
    } catch (e) {
      log(`default browser ${name}: could not open the login page (${errMsg(e)})`);
      return null;
    }
    log(`opened CurseForge login in default browser ${name}; polling its cookies every ${Math.round(this.loginPollMs / 1000)} s`);
    this.startLogin("default-browser", name, (gen) => this.pollDefaultBrowser(gen, name, fingerprint(probe.cookies)));
    return (
      `The CurseForge login page has opened in your default browser (${name}). Sign in there — ` +
      "your session is captured automatically; then re-run your action."
    );
  }

  /** Track a background login poll (one at a time; cancelled by bumping loginGeneration). */
  private startLogin(via: Exclude<LoginVia, "browser-extract" | null>, browser: string | null, poll: (gen: number) => Promise<void>): void {
    this.via = via;
    this.viaBrowser = browser;
    this.loginPolling = true;
    const gen = this.loginGeneration;
    const task = poll(gen).finally(() => {
      if (this.loginTask === task) {
        this.loginTask = null;
        this.loginPolling = false;
      }
    });
    this.loginTask = task;
  }

  /** Poll the default browser's cookie store; check the session whenever its cookies change. */
  private async pollDefaultBrowser(gen: number, name: string, seen: string): Promise<void> {
    const start = Date.now();
    const cancelled = () => gen !== this.loginGeneration;
    while (Date.now() - start < this.loginMaxWaitMs) {
      await new Promise((r) => setTimeout(r, this.loginPollMs));
      if (cancelled()) return;
      const r = await this.extractFrom(name).catch((e): ExtractionResult => ({ browser: name, cookies: [], error: errMsg(e) }));
      if (cancelled()) return;
      if (r.error || r.cookies.length === 0) continue;
      const fp = fingerprint(r.cookies);
      if (fp === seen) continue;
      seen = fp;
      const status = await this.trySession(r.cookies);
      if (cancelled()) return;
      if (status.loggedIn) {
        this.saveSession("browser", name);
        this.loginAttempted = false;
        log(`captured session: source browser/${name} (${r.cookies.length} cookies)`);
        return;
      }
    }
    log(`default browser ${name}: login wait timed out (${Math.round(this.loginMaxWaitMs / 1000)} s)`);
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
    try {
      await this.browser.openLoginPage(LOGIN_URL);
    } catch (e) {
      log(`could not open the sign-in window: ${errMsg(e)}`);
      return `Could not open the login browser: ${errMsg(e)} (run: npx patchright install chromium)`;
    }
    log("opened the server sign-in window");
    this.startLogin("window", null, (gen) => this.pollForLogin(gen));

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
        if (cancelled()) return; // cancel / logout closes the window itself
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
          log(`captured session: source window (${cookies.length} cookies)`);
          return;
        }
      }
      log(`sign-in window: login wait timed out (${Math.round(maxWait / 1000)} s)`);
    } catch (e) {
      if (!cancelled()) log(`sign-in window lost: ${errMsg(e)}`);
    } finally {
      // Close the visible login window; the next request relaunches the hidden browser
      // on the same persistent profile, so the new session carries over. After a cancel
      // the browser belongs to the canceller (logout may already be clearing the profile).
      if (!cancelled()) await this.browser.close();
    }
  }

  /** Stop a running login (default-browser polling or the sign-in window, which is
   *  closed). Returns whether one was running. */
  async cancelLogin(): Promise<boolean> {
    const task = this.loginTask;
    if (!task) return false;
    this.loginGeneration++;
    this.loginTask = null;
    this.loginPolling = false;
    const via = this.via;
    if (via === "window") await this.browser.close();
    await task;
    log(`login cancelled (${via === "default-browser" ? `default browser ${this.viaBrowser}` : "sign-in window"})`);
    return true;
  }

  /** Sign out: stop any login, forget the cookies (memory, cookies file, live
   *  browser profile) and persist a signed-out marker so startup does not silently
   *  re-extract browser cookies until the next explicit sign-in. Idempotent. */
  async logout(): Promise<void> {
    await this.cancelLogin();
    this.loginAttempted = false;
    this.via = null;
    this.viaBrowser = null;
    this.cookies = [];
    rmSync(this.config.cookiesPath, { force: true });
    this.saveMeta({ source: null, browser: null, signedOut: true });
    try {
      await this.browser.clearSession();
    } catch (e) {
      // No browser available = no persistent profile session to clear.
      console.error(`[web-client] Could not clear the browser profile session: ${errMsg(e)}`);
    }
    log("signed out");
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
