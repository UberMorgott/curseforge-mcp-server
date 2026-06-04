import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "patchright";
import type { CookieEntry } from "../utils/types.js";
import { detectChromeExecutable } from "../utils/helpers.js";

interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

// 5 min idle window — long enough to avoid a costly full CF-challenge re-launch
// between successive requests, short enough to eventually free Chrome when idle.
const IDLE_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CF_WAIT_MS = 45_000;

export class BrowserClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mainPage: Page | null = null;
  private authorsPage: Page | null = null;
  private cookies: CookieEntry[] = [];
  private initPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  setCookies(cookies: CookieEntry[]): void {
    this.cookies = cookies;
    const mapped = cookies.map(toPlaywrightCookie);
    this.context?.addCookies(mapped).catch(() => {});
  }

  async request(
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    this.clearIdleTimer();
    await this.ensureInit();
    const isAuthors = url.includes("authors.curseforge.com");
    const page = isAuthors ? this.authorsPage : this.mainPage;
    if (!page) throw new Error("Browser page not initialized");

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    };

    const fetchOpts = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    let result = await this.evaluateWithTimeout(page, url, fetchOpts);

    // Retry once on 403 — re-navigate to pass CF challenge
    if (result.status === 403) {
      const cfUrl = isAuthors
        ? "https://authors.curseforge.com/"
        : "https://www.curseforge.com/";
      console.error("[browser-client] Got 403, re-navigating to pass CF challenge");
      await this.navigateAndWaitForCf(page, cfUrl);
      result = await this.evaluateWithTimeout(page, url, fetchOpts);
    }

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status}: ${url}${result.body ? `\n${result.body.slice(0, 500)}` : ""}`);
    }
    this.resetIdleTimer();
    if (result.contentType.includes("application/json")) {
      return JSON.parse(result.body);
    }
    return result.body;
  }

  async refreshPages(): Promise<void> {
    if (!this.context) return;
    // Re-add cookies and reload pages to pick up new auth session
    const mapped = this.cookies.map(toPlaywrightCookie);
    if (mapped.length) await this.context.addCookies(mapped);
    if (this.mainPage) {
      await this.navigateAndWaitForCf(this.mainPage, "https://www.curseforge.com/");
    }
    if (this.authorsPage) {
      await this.navigateAndWaitForCf(this.authorsPage, "https://authors.curseforge.com/");
    }
    console.error("[browser-client] Pages refreshed with new cookies");
  }

  /** Read the live session cookies straight from this dedicated browser context.
   *  Returns CurseForge cookies only, mapped to the minimal CookieEntry shape. */
  async getCookies(): Promise<CookieEntry[]> {
    await this.ensureInit();
    if (!this.context) return [];
    const all = await this.context.cookies();
    return all
      .filter((c) => c.domain.includes("curseforge.com"))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  }

  /** Bring the dedicated browser window to the foreground (un-minimize it — init()
   *  minimizes windows via CDP after the Cloudflare challenge) and navigate the main
   *  page to the login URL so the user can sign in directly in this browser. */
  async openLoginPage(url: string): Promise<void> {
    await this.ensureInit();
    if (!this.mainPage) {
      throw new Error("Browser main page not initialized; cannot open login page");
    }

    // Restore the window from its minimized state so the user can see and use it.
    // Mirrors init()'s single CDP setWindowBounds to "minimized" with a single
    // setWindowBounds to "normal".
    try {
      const cdp = await this.mainPage.context().newCDPSession(this.mainPage);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
    } catch {
      // CDP restore not supported — the page will still load; continue
    }

    await this.navigateAndWaitForCf(this.mainPage, url);
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    const b = this.browser;
    this.browser = null;
    this.context = null;
    this.mainPage = null;
    this.authorsPage = null;
    this.initPromise = null;
    if (b) {
      console.error("[browser-client] Closing Chrome");
      await b.close().catch(() => {});
    }
  }

  private async evaluateWithTimeout(
    page: Page,
    url: string,
    fetchOpts: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<FetchResult> {
    const fetchPromise = page.evaluate(
      async ({ reqUrl, opts }: { reqUrl: string; opts: { method: string; headers: Record<string, string>; body?: string } }) => {
        const r = await fetch(reqUrl, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body ?? undefined,
        });
        return {
          status: r.status,
          contentType: r.headers.get("content-type") || "",
          body: await r.text(),
        };
      },
      { reqUrl: url, opts: fetchOpts },
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`)), REQUEST_TIMEOUT_MS),
    );

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      console.error("[browser-client] Idle timeout, closing Chrome");
      this.close();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.mainPage) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.init();
    return this.initPromise;
  }

  private async init(): Promise<void> {
    let chromium: any;
    try {
      const mod = await import("patchright");
      chromium = mod.chromium || mod.default?.chromium;
    } catch {
      throw new Error(
        "patchright is required for Web API tools (comments, settings, description).\n" +
        "Install: npm install patchright\n" +
        "Then install the bundled browser: npx patchright install chromium",
      );
    }

    // Dedicated, persistent profile (this file has no Config dependency).
    // A stable userDataDir keeps the logged-in CurseForge session across runs and
    // isolates it from the user's own Chrome profile, so the two can coexist.
    const userDataDir = path.join(os.homedir(), ".curseforge-mcp", "chrome-profile");
    mkdirSync(userDataDir, { recursive: true });

    // patchright patches out automation flags (--enable-automation, navigator.webdriver, etc.)
    // Use launchPersistentContext for maximum stealth.
    //
    //   - `headless: false` is required to reliably pass the Cloudflare challenge, but it
    //     needs a real display: on Linux/CI run under xvfb (or an equivalent virtual display).
    //
    // Two launch strategies, tried in order:
    //   1. Bundled Chromium (no executablePath): a separate browser binary, so it coexists
    //      with the user's running Chrome and never hands off to it. This is the robust path.
    //   2. System Chrome (executablePath): fallback when the bundled browser isn't installed.
    //      Reuses the SAME dedicated userDataDir for session persistence. Can still fail if
    //      the user's own Chrome is already running off a shared install.
    const context = await this.launchContext(chromium, userDataDir);
    this.context = context;
    this.browser = context.browser();

    const playwrightCookies = this.cookies.map(toPlaywrightCookie);
    if (playwrightCookies.length) await context.addCookies(playwrightCookies);

    // Use existing blank page for main site
    const pages = context.pages();
    this.mainPage = pages[0] || await context.newPage();
    console.error("[browser-client] Navigating to www.curseforge.com...");
    await this.navigateAndWaitForCf(this.mainPage, "https://www.curseforge.com/");

    // Open second page for authors site
    this.authorsPage = await context.newPage();
    console.error("[browser-client] Navigating to authors.curseforge.com...");
    await this.navigateAndWaitForCf(this.authorsPage, "https://authors.curseforge.com/");

    // Minimize all browser windows via CDP after Cloudflare is passed
    for (const page of [this.mainPage, this.authorsPage]) {
      try {
        const cdp = await page.context().newCDPSession(page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
      } catch {
        // CDP minimize not supported — continue
      }
    }

    console.error("[browser-client] Chrome ready");
  }

  // Launch a persistent context, preferring patchright's bundled Chromium and falling back
  // to system Chrome. Both paths share the same dedicated userDataDir for session persistence.
  private async launchContext(chromium: any, userDataDir: string): Promise<BrowserContext> {
    // The Chrome sandbox cannot run as root and is unavailable in most containers; only
    // disable it where the platform actually requires it. Trusted CurseForge origins only.
    const needsNoSandbox =
      process.platform === "linux" &&
      typeof process.getuid === "function" &&
      process.getuid() === 0;
    const baseArgs = ["--lang=en-US", ...(needsNoSandbox ? ["--no-sandbox"] : [])];
    const launchOpts = {
      headless: false,
      args: baseArgs,
      viewport: null,
    } as const;

    // 1. Bundled Chromium — no executablePath means patchright uses its own browser binary.
    try {
      console.error("[browser-client] Launching bundled Chromium via patchright");
      return await chromium.launchPersistentContext(userDataDir, launchOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const bundledMissing =
        msg.includes("Executable doesn't exist") || msg.includes("patchright install");
      if (!bundledMissing) throw err;
      console.error("[browser-client] Bundled Chromium not installed, falling back to system Chrome");
    }

    // 2. System Chrome fallback — same dedicated userDataDir.
    const chromePath = detectChromeExecutable();
    if (!chromePath) {
      throw new Error(
        "patchright's bundled Chromium is not installed and no system Chrome was found.\n" +
        "Recommended: run `npx patchright install chromium` to install the bundled browser.\n" +
        "Or install Google Chrome so it can be detected (e.g. /usr/bin/google-chrome-stable).",
      );
    }

    console.error(`[browser-client] Launching system Chrome via patchright: ${chromePath}`);
    try {
      return await chromium.launchPersistentContext(userDataDir, {
        ...launchOpts,
        executablePath: chromePath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // When the user's own Chrome is already running, launching the same system chrome.exe
      // hands off to the existing instance and the new process exits immediately.
      const alreadyRunning =
        msg.includes("Target page, context or browser has been closed") ||
        msg.includes("has been closed");
      if (alreadyRunning) {
        throw new Error(
          "Could not launch Chrome for the Web tier because your system Chrome appears to be " +
          "already running (the new process handed off to the existing instance and exited).\n" +
          "Fix it one of two ways:\n" +
          "  (a) Close all Chrome windows and retry, or\n" +
          "  (b) Recommended: run `npx patchright install chromium` to install patchright's " +
          "bundled browser, which coexists with your running Chrome.",
        );
      }
      throw err;
    }
  }

  private async navigateAndWaitForCf(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const start = Date.now();
    while (Date.now() - start < CF_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const title: string = await page.evaluate(() => document.title);
        const isCf = title.includes("moment") || title.includes("момент");
        if (!isCf) {
          console.error(`[browser-client] CF passed for ${new URL(url).hostname} (${Date.now() - start}ms)`);
          return;
        }
        console.error(`[browser-client] Waiting for CF... (${Math.round((Date.now() - start) / 1000)}s)`);
      } catch {
        // Page might be navigating during CF resolution — just wait
      }
    }

    // Final check
    try {
      const title: string = await page.evaluate(() => document.title);
      if (!title.includes("moment") && !title.includes("момент")) {
        console.error(`[browser-client] CF passed for ${new URL(url).hostname}`);
      } else {
        console.error(`[browser-client] Warning: CF challenge did not resolve for ${url} after ${CF_WAIT_MS}ms`);
      }
    } catch {
      console.error(`[browser-client] Warning: page unstable after navigation for ${url}`);
    }
  }
}

function toPlaywrightCookie(c: CookieEntry): { name: string; value: string; domain: string; path: string } {
  return { name: c.name, value: c.value, domain: c.domain, path: c.path };
}
