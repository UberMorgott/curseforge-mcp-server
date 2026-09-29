import os from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const localAppData = () => process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

const appData = () => process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");

/** `<userData>\<last used profile>\(Network\)Cookies` + `Local State` of the first
 *  user-data dir that exists, or null when none does. */
function chromiumStore(dirs: string[]): { localState: string; db: string } | null {
  const userData = dirs.find((d) => existsSync(path.join(d, "Local State")));
  if (!userData) return null;
  const localState = path.join(userData, "Local State");
  let profile = "Default";
  try {
    profile = JSON.parse(readFileSync(localState, "utf-8"))?.profile?.last_used || "Default";
  } catch {
    // unreadable Local State: rookie reports the key error
  }
  const network = path.join(userData, profile, "Network", "Cookies");
  return { localState, db: existsSync(network) ? network : path.join(userData, profile, "Cookies") };
}

/** Chromium-based browser without a rookie shortcut, read via chromiumBased(Local State, Cookies). */
function chromiumUserData(r: Rookie, dirs: () => string[]): BrowserFn {
  return (domains) => {
    const store = chromiumStore(dirs());
    if (!store) throw new Error("not installed (no User Data dir with Local State)");
    return r.chromiumBased(store.localState, store.db, domains);
  };
}

/** Cookie DB file of a browser (Windows layouts), for change detection only; null = unknown. */
function storeDb(browser: string): string | null {
  const chromium: Record<string, () => string[]> = {
    chrome: () => [path.join(localAppData(), "Google", "Chrome", "User Data")],
    edge: () => [path.join(localAppData(), "Microsoft", "Edge", "User Data")],
    brave: () => [path.join(localAppData(), "BraveSoftware", "Brave-Browser", "User Data")],
    chromium: () => [path.join(localAppData(), "Chromium", "User Data")],
    vivaldi: () => [path.join(localAppData(), "Vivaldi", "User Data")],
    yandex: () => [path.join(localAppData(), "Yandex", "YandexBrowser", "User Data")],
    centbrowser: centBrowserDirs,
  };
  const key = browser.toLowerCase();
  if (chromium[key]) return chromiumStore(chromium[key]())?.db ?? null;
  if (key === "opera") {
    const root = path.join(appData(), "Opera Software", "Opera Stable");
    const network = path.join(root, "Network", "Cookies");
    return existsSync(network) ? network : existsSync(path.join(root, "Cookies")) ? path.join(root, "Cookies") : null;
  }
  if (key === "firefox") {
    const profiles = path.join(appData(), "Mozilla", "Firefox", "Profiles");
    try {
      const dbs = readdirSync(profiles)
        .map((d) => path.join(profiles, d, "cookies.sqlite"))
        .filter((f) => existsSync(f))
        .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
      return dbs[0] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Change signature of a browser's cookie DB (+ -wal / -journal): mtime and size via
 *  fs.stat, which works on a locked file and never triggers an unlock. null = unknown store. */
export async function cookieStoreSignature(browser: string): Promise<string | null> {
  const db = storeDb(browser);
  if (!db || !existsSync(db)) return null;
  return [db, `${db}-wal`, `${db}-journal`]
    .map((f) => {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}
let centDirs: string[] | null = null;

/** Cent Browser: the standard install dir, plus portable installs (User Data next to
 *  chrome.exe) found through the StartMenuInternet registration's open command. */
function centBrowserDirs(): string[] {
  if (centDirs) return centDirs;
  const dirs = [path.join(localAppData(), "CentBrowser", "User Data")];
  if (process.platform === "win32") {
    const reg = (args: string[]) => execFileSync("reg", args, { encoding: "utf-8", windowsHide: true, timeout: 10_000 });
    try {
      const keys = reg(["query", "HKCU\\Software\\Clients\\StartMenuInternet"])
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /\\CentBrowser[^\\]*$/i.test(l));
      for (const key of keys) {
        try {
          const exe = /REG_\w+\s+"?([^"\r\n]+?\.exe)/i.exec(reg(["query", `${key}\\shell\\open\\command`, "/ve"]))?.[1];
          if (exe) dirs.push(path.join(path.dirname(exe), "User Data"));
        } catch {
          // registration without an open command
        }
      }
    } catch {
      // no StartMenuInternet key
    }
  }
  centDirs = dirs;
  return dirs;
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
    ["yandex", chromiumUserData(r, () => [path.join(localAppData(), "Yandex", "YandexBrowser", "User Data")])],
    ["centbrowser", chromiumUserData(r, centBrowserDirs)],
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

/** Cookies whose values all came back empty = the store's encryption was not decrypted
 *  (e.g. a newer Chromium cookie format rookie does not handle): unreadable, not "no session". */
export const UNDECRYPTED = "cookie values could not be decrypted (all empty)";

/** Result for cookies read from one browser; an all-empty-values store counts as unreadable. */
export function extractionResult(browser: string, cookies: CookieEntry[]): ExtractionResult {
  if (cookies.length > 0 && cookies.every((c) => !c.value)) {
    return { browser, cookies: [], error: `${UNDECRYPTED}: ${cookies.length} cookies` };
  }
  return { browser, cookies };
}

function readOne(name: string, fn: BrowserFn): ExtractionResult {
  try {
    return extractionResult(name, toCookieEntries(fn(CF_DOMAINS)));
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
