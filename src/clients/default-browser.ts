// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 (https://creativecommons.org/licenses/by-nc/4.0/)

import { execFile } from "node:child_process";

export interface DefaultBrowser {
  /** Raw https handler ProgId (Windows), or null when unknown. */
  progId: string | null;
  /** Cookie-extractor browser key (chrome, edge, firefox, ...), or null when unmapped. */
  browser: string | null;
}

const USER_CHOICE_KEY = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

/** Map a Windows https-handler ProgId to a cookie-extractor browser key. */
export function browserFromProgId(progId: string | null): string | null {
  if (!progId) return null;
  if (progId === "ChromeHTML") return "chrome";
  if (progId === "MSEdgeHTM") return "edge";
  if (progId.startsWith("FirefoxURL")) return "firefox";
  if (progId === "BraveHTML") return "brave";
  if (progId.startsWith("Opera")) return "opera";
  if (progId === "VivaldiHTM") return "vivaldi";
  if (progId === "YandexHTML") return "yandex";
  if (progId.startsWith("CentHTM")) return "centbrowser";
  return null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** The user's default browser (Windows registry UserChoice); unknown elsewhere. */
export async function detectDefaultBrowser(): Promise<DefaultBrowser> {
  if (process.platform !== "win32") return { progId: null, browser: null };
  try {
    const out = await run("reg", ["query", USER_CHOICE_KEY, "/v", "ProgId"]);
    const progId = /ProgId\s+REG_\w+\s+(\S+)/i.exec(out)?.[1] ?? null;
    return { progId, browser: browserFromProgId(progId) };
  } catch {
    return { progId: null, browser: null };
  }
}

/** Open a URL in the user's default browser (Windows only; the caller skips this path elsewhere). */
export async function openInDefaultBrowser(url: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("opening the default browser is only supported on Windows");
  await run("rundll32", ["url.dll,FileProtocolHandler", url]);
}
