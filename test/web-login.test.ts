// autoExtractCookies: extracted cookies are kept only with a signed-in session;
// anonymous ones are rolled back and the login window opens. Fake browser, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebClient, type WebBrowser } from "../src/clients/web-client.js";
import type { Config } from "../src/config.js";
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

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "condition not reached");
};

test("anonymous extracted cookies: restore previous, open login window, capture session, close window", async () => {
  const cfg = config();
  writeFileSync(cfg.cookiesPath, JSON.stringify([ck("Old")]));
  const { b, log } = fakeBrowser([ck("SiteUserToken"), ck("SignedIn")]);
  const client = new WebClient(cfg, {
    browser: b,
    extract: async () => ({ cookies: [ck("Anon")], browser: "chrome" }),
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
  const client = new WebClient(cfg, {
    browser: b,
    extract: async () => ({ cookies: [ck("Anon")], browser: "edge" }),
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
  const client = new WebClient(cfg, {
    browser: b,
    extract: async () => ({ cookies: [ck("SignedIn")], browser: "firefox" }),
  });
  const r = await client.autoExtractCookies();
  assert.deepEqual(r, { message: "Extracted 1 cookies from firefox", loggedIn: true });
  assert.equal(client.loginInProgress, false);
  assert.ok(!log.includes("open"));
  assert.deepEqual(JSON.parse(readFileSync(cfg.cookiesPath, "utf8")).map((c: CookieEntry) => c.name), ["SignedIn"]);
});

const metaOf = (cfg: Config) => JSON.parse(readFileSync(path.join(cfg.authDir, "session.json"), "utf8"));

test("session source: browser extract persists browser name across restarts", async () => {
  const cfg = config();
  const client = new WebClient(cfg, { browser: fakeBrowser([]).b, extract: async () => ({ cookies: [ck("SignedIn")], browser: "firefox" }) });
  await client.autoExtractCookies();
  assert.equal(client.sessionSource, "browser");
  assert.equal(client.sessionBrowser, "firefox");
  const again = new WebClient(cfg, { browser: fakeBrowser([]).b, extract: async () => assert.fail("no extract with stored cookies") });
  again.init();
  assert.equal(again.sessionSource, "browser");
  assert.equal(again.sessionBrowser, "firefox");
});

test("session source: startup background extract counts as browser", async () => {
  const cfg = config();
  const client = new WebClient(cfg, { browser: fakeBrowser([]).b, extract: async () => ({ cookies: [ck("SignedIn")], browser: "edge" }) });
  client.init();
  await waitFor(() => client.hasCookies());
  await waitFor(() => existsSync(path.join(cfg.authDir, "session.json")));
  assert.equal(client.sessionSource, "browser");
  assert.equal(client.sessionBrowser, "edge");
});

test("session source: login window capture is window, cf_set_cookies is manual, legacy file is null", async () => {
  const cfg = config();
  const client = new WebClient(cfg, {
    browser: fakeBrowser([ck("SiteUserToken"), ck("SignedIn")]).b,
    extract: async () => ({ cookies: [], browser: "chrome" }),
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
  assert.equal(new WebClient(legacy, { browser: fakeBrowser([]).b }).sessionSource, null);
});

test("logout: stops login polling, clears cookies everywhere, no silent re-extract until explicit sign-in", async () => {
  const cfg = config();
  writeFileSync(cfg.cookiesPath, JSON.stringify([ck("Old")]));
  const { b, log } = fakeBrowser([]); // login window never yields a session
  const client = new WebClient(cfg, {
    browser: b,
    extract: async () => ({ cookies: [ck("Anon")], browser: "chrome" }),
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
  const restarted = new WebClient(cfg, {
    browser: fakeBrowser([]).b,
    extract: async () => (extracts++, { cookies: [ck("SignedIn")], browser: "chrome" }),
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
  const client = new WebClient(cfg, { browser: fakeBrowser([]).b });
  await client.logout();
  assert.equal(client.signedOut, true);
  client.setCookiesFromString("SignedIn=1");
  assert.equal(client.signedOut, false);
  assert.equal(client.sessionSource, "manual");
});
