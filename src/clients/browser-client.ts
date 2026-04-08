import type { CookieEntry } from "../utils/types.js";
import { detectChromeExecutable } from "../utils/helpers.js";

interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

const IDLE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CF_WAIT_MS = 45_000;

export class BrowserClient {
  private browser: any = null;
  private context: any = null;
  private mainPage: any = null;
  private authorsPage: any = null;
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

  async requestUpload(
    url: string,
    fileBase64: string,
    fileName: string,
    metadataJson: string,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    this.clearIdleTimer();
    await this.ensureInit();
    const page = this.mainPage;

    const result: FetchResult = await page.evaluate(
      async ({ reqUrl, b64, name, meta, hdrs }: {
        reqUrl: string; b64: string; name: string; meta: string; hdrs: Record<string, string>;
      }) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const formData = new FormData();
        formData.append("metadata", meta);
        formData.append("file", new Blob([bytes]), name);

        const r = await fetch(reqUrl, {
          method: "POST",
          headers: hdrs,
          body: formData,
        });
        return {
          status: r.status,
          contentType: r.headers.get("content-type") || "",
          body: await r.text(),
        };
      },
      { reqUrl: url, b64: fileBase64, name: fileName, meta: metadataJson, hdrs: extraHeaders || {} },
    );

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Upload failed (${result.status}): ${result.body?.slice(0, 500) || url}`);
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
    page: any,
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
        "Also ensure Chrome or Chromium is installed on your system.",
      );
    }

    const chromePath = detectChromeExecutable();
    if (!chromePath) {
      throw new Error(
        "Could not find Chrome or Chromium.\n" +
        "Install Chrome and ensure it is accessible (e.g. /usr/bin/google-chrome-stable).",
      );
    }

    console.error(`[browser-client] Launching Chrome via patchright: ${chromePath}`);

    // patchright patches out automation flags (--enable-automation, navigator.webdriver, etc.)
    // Use launchPersistentContext for maximum stealth
    this.context = await chromium.launchPersistentContext("", {
      headless: false,
      executablePath: chromePath,
      args: ["--no-sandbox", "--lang=en-US"],
      viewport: null,
    });
    this.browser = this.context.browser?.() || this.context;

    const playwrightCookies = this.cookies.map(toPlaywrightCookie);
    if (playwrightCookies.length) await this.context.addCookies(playwrightCookies);

    // Use existing blank page for main site
    const pages = this.context.pages();
    this.mainPage = pages[0] || await this.context.newPage();
    console.error("[browser-client] Navigating to www.curseforge.com...");
    await this.navigateAndWaitForCf(this.mainPage, "https://www.curseforge.com/");

    // Open second page for authors site
    this.authorsPage = await this.context.newPage();
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

  private async navigateAndWaitForCf(page: any, url: string): Promise<void> {
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
