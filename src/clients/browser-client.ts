import type { CookieEntry } from "../utils/types.js";
import { detectChromeExecutable } from "../utils/helpers.js";

interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

export class BrowserClient {
  private browser: any = null;
  private mainPage: any = null;
  private authorsPage: any = null;
  private cookies: CookieEntry[] = [];
  private initPromise: Promise<void> | null = null;

  setCookies(cookies: CookieEntry[]): void {
    this.cookies = cookies;
    const mapped = cookies.map(toPuppeteerCookie);
    this.mainPage?.setCookie(...mapped).catch(() => {});
    this.authorsPage?.setCookie(...mapped).catch(() => {});
  }

  async request(
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    await this.ensureInit();
    const page = url.includes("authors.curseforge.com") ? this.authorsPage : this.mainPage;

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

    const result: FetchResult = await page.evaluate(
      async (reqUrl: string, opts: { method: string; headers: Record<string, string>; body?: string }) => {
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
      url,
      fetchOpts,
    );

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status}: ${url}${result.body ? `\n${result.body.slice(0, 500)}` : ""}`);
    }
    if (result.contentType.includes("application/json")) {
      return JSON.parse(result.body);
    }
    return result.body;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.mainPage = null;
      this.authorsPage = null;
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.mainPage) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.init();
    return this.initPromise;
  }

  private async init(): Promise<void> {
    let connectFn: any;
    try {
      const mod = await import("puppeteer-real-browser");
      connectFn = mod.connect || mod.default?.connect;
    } catch {
      throw new Error(
        "puppeteer-real-browser is required for Web API tools (comments, settings, description).\n" +
        "Install: npm install puppeteer-real-browser\n" +
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

    console.error(`[browser-client] Launching Chrome: ${chromePath}`);

    const { browser, page: firstPage } = await connectFn({
      headless: false,
      turnstile: true,
      args: ["--no-sandbox", "--window-size=800,600", "--lang=en-US"],
      customConfig: { chromePath },
    });

    this.browser = browser;
    const puppeteerCookies = this.cookies.map(toPuppeteerCookie);

    // Use the page from connect() for main site
    this.mainPage = firstPage;
    if (puppeteerCookies.length) await this.mainPage.setCookie(...puppeteerCookies);
    await this.navigateAndWaitForCf(this.mainPage, "https://www.curseforge.com/");

    // Open second page for authors site
    this.authorsPage = await browser.newPage();
    if (puppeteerCookies.length) await this.authorsPage.setCookie(...puppeteerCookies);
    await this.navigateAndWaitForCf(this.authorsPage, "https://authors.curseforge.com/");

    console.error("[browser-client] Chrome ready");
  }

  private async navigateAndWaitForCf(page: any, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const maxWait = 30000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const title: string = await page.evaluate(() => document.title);
        const isCf = title.includes("moment") || title.includes("момент");
        if (!isCf) {
          console.error(`[browser-client] CF passed for ${new URL(url).hostname}`);
          return;
        }
      } catch {
        try {
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
        } catch {}
      }
    }

    // Final check
    try {
      const title: string = await page.evaluate(() => document.title);
      if (!title.includes("moment") && !title.includes("момент")) {
        console.error(`[browser-client] CF passed for ${new URL(url).hostname}`);
      } else {
        console.error(`[browser-client] Warning: CF challenge did not resolve for ${url}`);
      }
    } catch {
      console.error(`[browser-client] Warning: page unstable after navigation for ${url}`);
    }
  }
}

function toPuppeteerCookie(c: CookieEntry): { name: string; value: string; domain: string; path: string } {
  return { name: c.name, value: c.value, domain: c.domain, path: c.path };
}
