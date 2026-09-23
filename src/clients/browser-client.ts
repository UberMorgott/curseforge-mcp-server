import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "patchright";
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
  /** Whether the current context was launched headed (interactive login). */
  private visible = false;
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

  /** Open the login URL in a VISIBLE browser window so the user can sign in.
   *  The normal (hidden, headless) context is closed first — both share the same
   *  persistent profile, which only one Chrome process can hold at a time.
   *  Call close() after login finishes; the next request relaunches hidden. */
  async openLoginPage(url: string): Promise<void> {
    if (this.initPromise && !this.visible) await this.close();
    await this.ensureInit(true);
    if (!this.mainPage) {
      throw new Error("Browser main page not initialized; cannot open login page");
    }
    await this.navigateAndWaitForCf(this.mainPage, url);
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    const pending = this.initPromise;
    this.initPromise = null;
    if (pending) await pending.catch(() => {});
    const ctx = this.context;
    this.context = null;
    this.mainPage = null;
    this.authorsPage = null;
    // A persistent context has no separate Browser object (context.browser() is null),
    // so the context itself must be closed to terminate Chrome.
    if (ctx) {
      console.error("[browser-client] Closing Chrome");
      await ctx.close().catch(() => {});
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

  /** Reuse whatever context is open (hidden, or a visible login window still in use);
   *  otherwise launch one. `visible` only matters when a new context is launched. */
  private async ensureInit(visible = false): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.visible = visible || process.env.CURSEFORGE_BROWSER_VISIBLE === "1";
    const p = this.init(this.visible);
    this.initPromise = p;
    p.catch(() => {
      if (this.initPromise === p) this.initPromise = null;
    });
    return p;
  }

  private async init(visible: boolean): Promise<void> {
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
    //   - Normal requests run fully headless (new headless mode: the real Chrome binary, no
    //     window, no taskbar entry, no display needed). Cloudflare rejects headless only by
    //     its "HeadlessChrome" user-agent token, so preparePage() overrides the UA per page.
    //   - Interactive login (visible=true) runs headed so the user can sign in.
    //
    // Two launch strategies, tried in order:
    //   1. Bundled Chromium (no executablePath): a separate browser binary, so it coexists
    //      with the user's running Chrome and never hands off to it. This is the robust path.
    //   2. System Chrome (executablePath): fallback when the bundled browser isn't installed.
    //      Reuses the SAME dedicated userDataDir for session persistence. Can still fail if
    //      the user's own Chrome is already running off a shared install.
    const context = await this.launchContext(chromium, userDataDir, visible);
    this.context = context;
    try {
      const playwrightCookies = this.cookies.map(toPlaywrightCookie);
      if (playwrightCookies.length) await context.addCookies(playwrightCookies);

      // Use existing blank page for main site
      const pages = context.pages();
      const mainPage = pages[0] || await context.newPage();
      await this.preparePage(mainPage);
      console.error("[browser-client] Navigating to www.curseforge.com...");
      await this.navigateAndWaitForCf(mainPage, "https://www.curseforge.com/");

      // Open second page for authors site
      const authorsPage = await context.newPage();
      await this.preparePage(authorsPage);
      console.error("[browser-client] Navigating to authors.curseforge.com...");
      await this.navigateAndWaitForCf(authorsPage, "https://authors.curseforge.com/");

      this.mainPage = mainPage;
      this.authorsPage = authorsPage;
    } catch (err) {
      this.context = null;
      await context.close().catch(() => {});
      throw err;
    }

    console.error(`[browser-client] Chrome ready (${visible ? "visible" : "headless"})`);
  }

  /** Headless Chrome advertises "HeadlessChrome" in its user agent, which Cloudflare
   *  blocks. Replace it with the real browser's plain UA (version kept exact). */
  private async preparePage(page: Page): Promise<void> {
    if (this.visible) return;
    const cdp = await page.context().newCDPSession(page);
    const { userAgent } = await cdp.send("Browser.getVersion");
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: userAgent.replace("HeadlessChrome", "Chrome"),
    });
  }

  // Launch a persistent context, preferring patchright's bundled Chromium and falling back
  // to system Chrome. Both paths share the same dedicated userDataDir for session persistence.
  private async launchContext(
    chromium: any,
    userDataDir: string,
    visible: boolean,
  ): Promise<BrowserContext> {
    // The Chrome sandbox cannot run as root and is unavailable in most containers; only
    // disable it where the platform actually requires it. Trusted CurseForge origins only.
    const needsNoSandbox =
      process.platform === "linux" &&
      typeof process.getuid === "function" &&
      process.getuid() === 0;
    const baseArgs = ["--lang=en-US", ...(needsNoSandbox ? ["--no-sandbox"] : [])];
    const launchOpts = {
      headless: !visible,
      args: baseArgs,
      viewport: null,
    };

    // 1. Bundled Chromium — no executablePath means patchright uses its own browser binary.
    //    channel "chromium" selects the full browser (new headless mode) instead of the
    //    stripped chromium-headless-shell.
    try {
      console.error(
        `[browser-client] Launching bundled Chromium via patchright (headless=${launchOpts.headless})`,
      );
      return await chromium.launchPersistentContext(userDataDir, { ...launchOpts, channel: "chromium" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const bundledMissing =
        msg.includes("Executable doesn't exist") || msg.includes("patchright install");
      if (!bundledMissing) throw err;
      console.error(
        `[browser-client] Bundled Chromium not installed, falling back to system Chrome (${msg.split("\n")[0]})`,
      );
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

    console.error(`[browser-client] Launching system Chrome via patchright (headless=${launchOpts.headless}): ${chromePath}`);
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
