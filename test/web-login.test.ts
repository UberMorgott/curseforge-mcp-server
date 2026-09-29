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
