// autoExtractCookies: extracted cookies are kept only with a signed-in session;
// anonymous ones are rolled back and the login window opens. Fake browser, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebClient, type WebBrowser } from "../src/clients/web-client.js";
import type { Config } from "../src/config.js";
import { browserFromProgId } from "../src/clients/default-browser.js";
import type { CookieEntry } from "../src/utils/types.js";

const ck = (name: string, value = "v"): CookieEntry => ({ name, value, domain: ".curseforge.com", path: "/" });

function config(): Config {
  const authDir = mkdtempSync(path.join(tmpdir(), "cf-web-login-"));
  return { curseforgeApiKey: "", curseforgeAuthorToken: "", curseforgeGameSlug: "", uploadDir: "", authDir, cookiesPath: path.join(authDir, "cookies.json") };
}

/** Signed in iff the current cookies contain `SignedIn`; login window yields `loginCookies`. */
function fakeBrowser(loginCookies: CookieEntry[]) {
  const log: string[] = [];
  let current: CookieEntry[] = [];
  const b: WebBrowser = {
    setCookies(c) { current = c; log.push(`set:${c.map((x) => x.name).join(",")}`); },
    async request(url) {
      log.push(`request:${url}`);
      if (current.some((c) => c.name === "SignedIn")) return { userId: 7, displayName: "Tester", userName: "tester" };
      throw new Error(`HTTP 401: ${url}`);
    },
    async openLoginPage() { log.push("open"); },
    async getCookies() { return loginCookies; },
    async close() { log.push("close"); },
    async clearSession() { current = []; log.push("clear"); },
  };
  return { b, log };
}

/** No usable default browser: step 2 is skipped (never touches the real registry / browsers). */
const noDefault = {
  detectDefaultBrowser: async () => ({ progId: null, browser: null }),
  extractFrom: async (browser: string) => ({ browser, cookies: [], error: "not installed" }),
  openUrl: async () => assert.fail("default browser must not be opened"),
};

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "condition not reached");
};

test("anonymous extracted cookies: restore previous, open login window, capture session, close window", async () => {
  const cfg = config();
  writeFileSync(cfg.cookiesPath, JSON.stringify([ck("Old")]));
  const { b, log } = fakeBrowser([ck("SiteUserToken"), ck("SignedIn")]);
  const client = new WebClient(cfg, { ...noDefault,
    browser: b,
    extractAll: async () => [{ cookies: [ck("Anon")], browser: "chrome" }],
    loginPollMs: 1,
    loginMaxWaitMs: 5_000,
  });

  const r = await client.autoExtractCookies();
  assert.equal(r.loggedIn, false);
  assert.match(r.message, /login window has opened/i);
  assert.ok(client.loginInProgress);
  assert.deepEqual(log.slice(0, 4), ["set:Anon", "request:https://www.curseforge.com/api/v1/users/profile", "set:Old", "open"]);
  assert.deepEqual(JSON.parse(readFileSync(cfg.cookiesPath, "utf8")).map((c: CookieEntry) => c.name), ["Old"], "anonymous cookies never saved");

  await waitFor(() => !client.loginInProgress);
  assert.ok(log.includes("close"), "login window closed after capture");
  assert.deepEqual(JSON.parse(readFileSync(cfg.cookiesPath, "utf8")).map((c: CookieEntry) => c.name), ["SiteUserToken", "SignedIn"]);
  assert.equal((await client.sessionStatus()).user?.displayName, "Tester");
});

test("anonymous extracted cookies with no previous session: nothing kept, login opens", async () => {
  const cfg = config();
  const { b, log } = fakeBrowser([]);
  const client = new WebClient(cfg, { ...noDefault,
    browser: b,
    extractAll: async () => [{ cookies: [ck("Anon")], browser: "edge" }],
    loginPollMs: 1,
    loginMaxWaitMs: 20,
  });
  const r = await client.autoExtractCookies();
  assert.equal(r.loggedIn, false);
  assert.equal(client.hasCookies(), false);
  assert.ok(log.includes("open"));
  assert.equal(existsSync(cfg.cookiesPath), false);
  await waitFor(() => !client.loginInProgress);
  assert.ok(log.includes("close"), "login window closed after timeout");
});

test("signed-in extracted cookies: kept, no login window", async () => {
  const cfg = config();
  const { b, log } = fakeBrowser([]);
  const client = new WebClient(cfg, { ...noDefault,
    browser: b,
    extractAll: async () => [{ cookies: [ck("SignedIn")], browser: "firefox" }],
  });
  const r = await client.autoExtractCookies();
  assert.deepEqual(r, { message: "Extracted 1 cookies from firefox", loggedIn: true, loginStarted: false });
  assert.equal(client.loginInProgress, false);
  assert.ok(!log.includes("open"));
  assert.deepEqual(JSON.parse(readFileSync(cfg.cookiesPath, "utf8")).map((c: CookieEntry) => c.name), ["SignedIn"]);
});

const metaOf = (cfg: Config) => JSON.parse(readFileSync(path.join(cfg.authDir, "session.json"), "utf8"));

test("session source: browser extract persists browser name across restarts", async () => {
  const cfg = config();
  const client = new WebClient(cfg, { ...noDefault, browser: fakeBrowser([]).b, extractAll: async () => [{ cookies: [ck("SignedIn")], browser: "firefox" }] });
  await client.autoExtractCookies();
  assert.equal(client.sessionSource, "browser");
  assert.equal(client.sessionBrowser, "firefox");
  const again = new WebClient(cfg, { ...noDefault, browser: fakeBrowser([]).b, extractAll: async () => assert.fail("no extract with stored cookies") });
  again.init();
  assert.equal(again.sessionSource, "browser");
  assert.equal(again.sessionBrowser, "firefox");
});

test("session source: startup background extract counts as browser", async () => {
  const cfg = config();
  const client = new WebClient(cfg, { ...noDefault, browser: fakeBrowser([]).b, extractAll: async () => [{ cookies: [ck("SignedIn")], browser: "edge" }] });
  client.init();
  await waitFor(() => client.hasCookies());
  await waitFor(() => existsSync(path.join(cfg.authDir, "session.json")));
  assert.equal(client.sessionSource, "browser");
  assert.equal(client.sessionBrowser, "edge");
});

test("session source: login window capture is window, cf_set_cookies is manual, legacy file is null", async () => {
  const cfg = config();
  const client = new WebClient(cfg, { ...noDefault,
    browser: fakeBrowser([ck("SiteUserToken"), ck("SignedIn")]).b,
    extractAll: async () => [{ cookies: [], browser: "chrome" }],
    loginPollMs: 1,
    loginMaxWaitMs: 5_000,
  });
  await client.autoExtractCookies();
  await waitFor(() => !client.loginInProgress);
  assert.equal(client.sessionSource, "window");
  assert.equal(client.sessionBrowser, null);

  client.setCookiesFromString("SignedIn=1; Other=2");
  assert.equal(client.sessionSource, "manual");
  assert.deepEqual(metaOf(cfg), { source: "manual", browser: null, signedOut: false });

  const legacy = config();
  writeFileSync(legacy.cookiesPath, JSON.stringify([ck("Old")]));
  assert.equal(new WebClient(legacy, { ...noDefault, browser: fakeBrowser([]).b }).sessionSource, null);
});

test("logout: stops login polling, clears cookies everywhere, no silent re-extract until explicit sign-in", async () => {
  const cfg = config();
  writeFileSync(cfg.cookiesPath, JSON.stringify([ck("Old")]));
  const { b, log } = fakeBrowser([]); // login window never yields a session
  const client = new WebClient(cfg, { ...noDefault,
    browser: b,
    extractAll: async () => [{ cookies: [ck("Anon")], browser: "chrome" }],
    loginPollMs: 1,
    loginMaxWaitMs: 60_000,
  });
  await client.autoExtractCookies();
  assert.ok(client.loginInProgress);

  await client.logout();
  assert.equal(client.loginInProgress, false);
  assert.equal(client.hasCookies(), false);
  assert.equal(client.sessionSource, null);
  assert.equal(existsSync(cfg.cookiesPath), false, "cookies file deleted");
  assert.ok(log.includes("clear"), "live browser profile cookies cleared");
  assert.deepEqual(metaOf(cfg), { source: null, browser: null, signedOut: true });
  await client.logout(); // idempotent

  let extracts = 0;
  const restarted = new WebClient(cfg, { ...noDefault,
    browser: fakeBrowser([]).b,
    extractAll: async () => (extracts++, [{ cookies: [ck("SignedIn")], browser: "chrome" }]),
  });
  restarted.init();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(extracts, 0, "startup must not re-extract after logout");
  assert.equal(restarted.hasCookies(), false);

  const r = await restarted.autoExtractCookies();
  assert.equal(r.loggedIn, true);
  assert.equal(extracts, 1);
  assert.equal(restarted.signedOut, false);
  assert.deepEqual(metaOf(cfg), { source: "browser", browser: "chrome", signedOut: false });
});

test("logout then cf_set_cookies clears the signed-out marker", async () => {
  const cfg = config();
  const client = new WebClient(cfg, { ...noDefault, browser: fakeBrowser([]).b });
  await client.logout();
  assert.equal(client.signedOut, true);
  client.setCookiesFromString("SignedIn=1");
  assert.equal(client.signedOut, false);
  assert.equal(client.sessionSource, "manual");
});

test("path 1: silent extract tries every browser, keeps the first signed-in one, logs each step", async () => {
  const cfg = config();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const client = new WebClient(cfg, { ...noDefault,
      browser: fakeBrowser([]).b,
      extractAll: async () => [
        { browser: "chrome", cookies: [], error: "app-bound encryption" },
        { browser: "edge", cookies: [ck("Anon")] },
        { browser: "firefox", cookies: [ck("SignedIn")] },
      ],
    });
    const r = await client.autoExtractCookies();
    assert.deepEqual(r, { message: "Extracted 1 cookies from firefox", loggedIn: true, loginStarted: false });
    assert.equal(client.loginVia, "browser-extract");
    assert.equal(client.loginBrowser, null);
    assert.equal(client.sessionSource, "browser");
    assert.equal(client.sessionBrowser, "firefox");
  } finally {
    console.error = orig;
  }
  const login = lines.filter((l) => l.startsWith("[login] "));
  assert.ok(login.some((l) => /extract chrome: error \(app-bound encryption\)/.test(l)));
  assert.ok(login.some((l) => /extract edge: 1 cookies, signed in: no/.test(l)));
  assert.ok(login.some((l) => /extract firefox: 1 cookies, signed in: yes/.test(l)));
  assert.ok(login.some((l) => /captured session: source browser\/firefox/.test(l)));
});

test("path 2: readable default browser gets the login page and is polled until signed in", async () => {
  const cfg = config();
  const { b, log } = fakeBrowser([]);
  const opened: string[] = [];
  let polls = 0;
  const client = new WebClient(cfg, {
    browser: b,
    extractAll: async () => [],
    detectDefaultBrowser: async () => ({ progId: "MSEdgeHTM", browser: "edge" }),
    extractFrom: async (browser) => ({ browser, cookies: polls++ < 3 ? [ck("Anon")] : [ck("Anon"), ck("SignedIn")] }),
    openUrl: async (url) => { opened.push(url); },
    loginPollMs: 1,
    loginMaxWaitMs: 5_000,
  });
  const r = await client.autoExtractCookies();
  assert.equal(r.loggedIn, false);
  assert.equal(r.loginStarted, true);
  assert.match(r.message, /default browser \(edge\)/);
  assert.deepEqual(opened, ["https://www.curseforge.com/login"]);
  assert.equal(client.loginInProgress, true);
  assert.equal(client.loginVia, "default-browser");
  assert.equal(client.loginBrowser, "edge");
  assert.ok(!log.includes("open"), "no server sign-in window");

  await waitFor(() => !client.loginInProgress);
  assert.equal(client.sessionSource, "browser");
  assert.equal(client.sessionBrowser, "edge");
  assert.deepEqual(JSON.parse(readFileSync(cfg.cookiesPath, "utf8")).map((c: CookieEntry) => c.name), ["Anon", "SignedIn"]);
});

test("path 3: unreadable default browser store falls back to the sign-in window", async () => {
  const cfg = config();
  const { b, log } = fakeBrowser([ck("SiteUserToken"), ck("SignedIn")]);
  const client = new WebClient(cfg, {
    browser: b,
    extractAll: async () => [],
    detectDefaultBrowser: async () => ({ progId: "ChromeHTML", browser: "chrome" }),
    extractFrom: async (browser) => ({ browser, cookies: [], error: "app-bound encryption" }),
    openUrl: async () => assert.fail("default browser must not be opened"),
    loginPollMs: 1,
    loginMaxWaitMs: 5_000,
  });
  const r = await client.autoExtractCookies();
  assert.equal(r.loginStarted, true);
  assert.equal(client.loginVia, "window");
  assert.equal(client.loginBrowser, null);
  assert.ok(log.includes("open"));
  await waitFor(() => !client.loginInProgress);
  assert.equal(client.sessionSource, "window");
});

test("cf_login_cancel: stops default-browser polling and closes the sign-in window", async () => {
  const cfg = config();
  const client = new WebClient(cfg, {
    browser: fakeBrowser([]).b,
    extractAll: async () => [],
    detectDefaultBrowser: async () => ({ progId: "FirefoxURL-308046B0AF4A39CB", browser: "firefox" }),
    extractFrom: async (browser) => ({ browser, cookies: [ck("Anon")] }),
    openUrl: async () => {},
    loginPollMs: 1,
    loginMaxWaitMs: 60_000,
  });
  await client.autoExtractCookies();
  assert.equal(client.loginInProgress, true);
  assert.equal(await client.cancelLogin(), true);
  assert.equal(client.loginInProgress, false);
  assert.equal(await client.cancelLogin(), false);
  assert.equal(client.hasCookies(), false);

  const cfg2 = config();
  const { b, log } = fakeBrowser([]);
  const win = new WebClient(cfg2, { ...noDefault, browser: b, extractAll: async () => [], loginPollMs: 1, loginMaxWaitMs: 60_000 });
  await win.autoExtractCookies();
  assert.equal(win.loginVia, "window");
  assert.equal(await win.cancelLogin(), true);
  assert.equal(win.loginInProgress, false);
  assert.ok(log.includes("close"), "sign-in window closed");
});
test("default browser ProgId mapping (incl. Cent Browser)", () => {
  const cases: Array<[string | null, string | null]> = [
    ["ChromeHTML", "chrome"], ["MSEdgeHTM", "edge"], ["FirefoxURL-308046B0AF4A39CB", "firefox"], ["BraveHTML", "brave"],
    ["OperaGXStable", "opera"], ["VivaldiHTM", "vivaldi"], ["YandexHTML", "yandex"],
    ["CentHTM.PVOYJF5YAEQRUHCVWLHIFLU56M", "centbrowser"], ["SomethingElse", null], [null, null],
  ];
  for (const [progId, want] of cases) assert.equal(browserFromProgId(progId), want, String(progId));
});