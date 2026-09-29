import os from "node:os";
import path from "node:path";
import type { CookieObject } from "@rookie-rs/api";
import type { CookieEntry } from "../utils/types.js";

export interface ExtractionResult {
  browser: string;
  cookies: CookieEntry[];
  /** Set when the browser's cookie store could not be read (not installed, locked, app-bound encryption...). */
  error?: string;
}

const CF_DOMAINS = [".curseforge.com"];

type BrowserFn = (domains?: string[] | null) => CookieObject[];
type Rookie = typeof import("@rookie-rs/api");

function toCookieEntries(raw: CookieObject[]): CookieEntry[] {
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));
}

/** Yandex is Chromium-based but has no rookie shortcut (Windows profile layout). */
function yandex(r: Rookie): BrowserFn {
  return (domains) => {
    const base = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Yandex", "YandexBrowser", "User Data");
    return r.chromiumBased(path.join(base, "Local State"), path.join(base, "Default", "Network", "Cookies"), domains);
  };
}

/** Browser keys (lowercase) in the order the silent extraction tries them. */
function browserTable(r: Rookie): Array<[string, BrowserFn]> {
  return [
    ["chrome", r.chrome],
    ["firefox", r.firefox],
    ["edge", r.edge],
    ["brave", r.brave],
    ["chromium", r.chromium],
    ["opera", r.opera],
    ["opera gx", r.operaGx],
    ["vivaldi", r.vivaldi],
    ["yandex", yandex(r)],
    ["arc", r.arc],
    ["librewolf", r.librewolf],
    ["octobrowser", r.octoBrowser],
    ["internet explorer", r.internetExplorer],
  ];
}

const UNAVAILABLE = "@rookie-rs/api not available on this platform. Use cf_set_cookies to set cookies manually.";

async function loadRookie(): Promise<Rookie | null> {
  try {
    return await import("@rookie-rs/api");
  } catch {
    return null;
  }
}

function readOne(name: string, fn: BrowserFn): ExtractionResult {
  try {
    return { browser: name, cookies: toCookieEntries(fn(CF_DOMAINS)) };
  } catch (e) {
    return { browser: name, cookies: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export class CookieExtractor {
  /** Every known browser, one result each (cookies, or the read error). */
  async extractAll(): Promise<ExtractionResult[]> {
    const r = await loadRookie();
    if (!r) return [{ browser: "none", cookies: [], error: UNAVAILABLE }];
    return browserTable(r).map(([name, fn]) => readOne(name, fn));
  }

  /** One browser by key (e.g. "chrome", "edge"); `error` set when its store is unreadable. */
  async extractFrom(browser: string): Promise<ExtractionResult> {
    const r = await loadRookie();
    if (!r) return { browser, cookies: [], error: UNAVAILABLE };
    const entry = browserTable(r).find(([name]) => name === browser.toLowerCase());
    if (!entry) return { browser, cookies: [], error: `unsupported browser: ${browser}` };
    return readOne(entry[0], entry[1]);
  }

  /** First browser that has curseforge.com cookies (setup wizard, silent startup extract). */
  async extractCookies(): Promise<ExtractionResult> {
    const all = await this.extractAll();
    const hit = all.find((x) => x.cookies.length > 0);
    if (hit) {
      console.error(`[cookie-extractor] ${hit.cookies.length} cookies from ${hit.browser}`);
      return hit;
    }
    return { browser: "none", cookies: [], error: all[0]?.error === UNAVAILABLE ? UNAVAILABLE : "No browser had curseforge.com cookies" };
  }
}
