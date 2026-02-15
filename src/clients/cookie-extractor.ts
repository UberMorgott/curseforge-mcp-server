import type { CookieObject } from "@rookie-rs/api";
import type { CookieEntry } from "../utils/types.js";

export interface ExtractionResult {
  browser: string;
  cookies: CookieEntry[];
  error?: string;
}

const CF_DOMAINS = [".curseforge.com"];

type BrowserFn = (domains?: string[] | null) => CookieObject[];

function toCookieEntries(raw: CookieObject[]): CookieEntry[] {
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));
}

export class CookieExtractor {
  async extractCookies(): Promise<ExtractionResult> {
    let rookieApi: typeof import("@rookie-rs/api");
    try {
      rookieApi = await import("@rookie-rs/api");
    } catch {
      return {
        browser: "none",
        cookies: [],
        error:
          "@rookie-rs/api not available on this platform. Use cf_set_cookies to set cookies manually.",
      };
    }

    const browsers: Array<[string, BrowserFn]> = [
      ["Chrome", rookieApi.chrome],
      ["Firefox", rookieApi.firefox],
      ["Edge", rookieApi.edge],
      ["Brave", rookieApi.brave],
      ["Chromium", rookieApi.chromium],
      ["Opera", rookieApi.opera],
      ["Opera GX", rookieApi.operaGx],
      ["Vivaldi", rookieApi.vivaldi],
      ["Arc", rookieApi.arc],
      ["LibreWolf", rookieApi.librewolf],
      ["OctoBrowser", rookieApi.octoBrowser],
      ["Internet Explorer", rookieApi.internetExplorer],
    ];

    for (const [name, fn] of browsers) {
      try {
        const raw = fn(CF_DOMAINS);
        if (raw.length > 0) {
          const cookies = toCookieEntries(raw);
          console.error(
            `[cookie-extractor] ${cookies.length} cookies from ${name}`,
          );
          return { browser: name, cookies };
        }
      } catch {
        // browser not installed or inaccessible — skip
      }
    }
    return {
      browser: "none",
      cookies: [],
      error: "No browser had curseforge.com cookies",
    };
  }
}
