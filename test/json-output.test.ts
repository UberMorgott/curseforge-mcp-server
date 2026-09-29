// `format: "json"` shapes: saved API responses (test/fixtures; other users anonymized)
// → json mappers → zod schemas. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  authorJson,
  AuthorResultSchema,
  projectJson,
  ProjectResultSchema,
  commentsJson,
  CommentsResultSchema,
  findPosted,
  PostResultSchema,
  SessionResultSchema,
  ExtractResultSchema,
} from "../src/tools/json-shapes.js";
import { jsonResult, jsonError, errorCode, CodedError, isoUtc, writeError } from "../src/utils/structured.js";

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

test("search_author json (CFWidget)", () => {
  const j = AuthorResultSchema.parse(authorJson(fixture("cfwidget-author.json")));
  assert.deepEqual(j.author, { id: 136845864, username: "Morgott" });
  assert.deepEqual(j.projects.map((p) => p.id), [1437738, 1443010, 1443080]);
  assert.equal(j.projects[0].name, "Nick Name Changer");
});

test("get_project json (CFWidget)", () => {
  const j = ProjectResultSchema.parse(projectJson(fixture("cfwidget-project.json")));
  assert.equal(j.id, 1437738);
  assert.equal(j.game, "hytale");
  assert.equal(j.url, "https://www.curseforge.com/hytale/mods/nick-name-changer");
  assert.equal(j.createdAt, "2026-01-20T09:34:08.763Z");
  assert.equal(j.members[0].id, 136845864);
});

test("get_comments json: roots, flattened nested replies, paging, timestamps", () => {
  const d = fixture("cf-comments.json");
  const j = CommentsResultSchema.parse(commentsJson(1443010, 1, d));
  assert.equal(j.total, 28);
  assert.equal(j.pageSize, 20);
  assert.equal(j.pages, 2);
  assert.equal(j.comments.length, 11);
  const entries = j.comments.reduce((n, c) => n + 1 + c.replies.length, 0);
  assert.equal(entries, 20, "20 entries per page, replies count");

  const root = j.comments[0];
  assert.equal(root.id, "8450535");
  assert.equal(root.parentId, null);
  assert.equal(root.authorId, 136845864);
  assert.equal(root.createdAt, isoUtc(1790151824010));
  assert.ok(root.body.startsWith("CrossbowSaveArrow 0.0.9 is out"));
  // renderedHtml as posted (this one was sent as plain text); others carry <p> markup
  assert.ok(j.comments.some((c) => c.bodyHtml.startsWith("<p>")));

  // 7714392 → 7720818 (depth 1) → 7728649 (depth 2), flattened in site order
  const t = j.comments.find((c) => c.id === "7714392")!;
  assert.deepEqual(
    t.replies.map((r) => [r.id, r.parentId, r.depth]),
    [
      ["7720818", "7714392", 1],
      ["7728649", "7720818", 2],
    ],
  );
  const edited = j.comments.find((c) => c.id === "7665865")!;
  assert.equal(edited.updatedAt, isoUtc(1769816960447));
  assert.equal(root.updatedAt, null);
});

test("get_comments json: bodies untruncated, pinned flag", () => {
  const long = "x".repeat(5000);
  const j = commentsJson(1, 3, {
    data: [{ id: 1, text: long, body: `<p>${long}</p>`, author: { id: 2, username: "u", displayName: "U" }, datePosted: 1, isPinned: true, replies: [] }],
    pagination: { index: 2, totalCount: 41, pageSize: 20 },
  });
  assert.equal(j.comments[0].body.length, 5000);
  assert.equal(j.comments[0].pinned, true);
  assert.equal(j.pages, 3);
  assert.equal(j.page, 3);
  const empty = CommentsResultSchema.parse(commentsJson(1, 1, { data: [] }));
  assert.equal(empty.total, null);
  assert.equal(empty.pages, null);
});

test("post_comment read-back: newest match with the right parent", () => {
  const d = fixture("cf-comments.json");
  assert.equal(findPosted([d], "Which folder are you putting the mod in?", 7714392), "7720818");
  assert.equal(findPosted([d], "Which folder are you putting the mod in?", undefined), null);
  const root = d.data[0];
  assert.equal(findPosted([d], root.body, undefined), String(root.id));
  const dup = { data: [{ id: 5, text: "same", replies: [] }, { id: 9, text: "same", replies: [] }] };
  assert.equal(findPosted([dup], "<p>same</p>", undefined), "9");
});

test("json envelope and error codes", () => {
  const ok = jsonResult({ a: 1 });
  assert.deepEqual(ok.structuredContent, { a: 1 });
  assert.equal(JSON.parse(ok.content[0].text).a, 1);
  const err = jsonError("get_comments", new CodedError("not_logged_in", "No session cookies."));
  assert.equal(err.isError, true);
  assert.equal((err.structuredContent as any).error.code, "not_logged_in");
  assert.equal(errorCode(new Error("HTTP 401: https://www.curseforge.com/api/v1/users/profile")), "not_logged_in");
  assert.equal(errorCode(new Error("HTTP 403: https://www.curseforge.com/x\n<title>Just a moment...</title>")), "cloudflare");
  assert.equal(errorCode(new Error("CFWidget 500: /author/search/x\n{\"error\":\"record not found\"}")), "not_found");
  assert.equal(errorCode(new Error("HTTP 429: x")), "rate_limited");
  assert.equal(errorCode(new Error("boom")), "error");
  PostResultSchema.parse({ posted: true, id: null, parentId: "1", verified: false });
  SessionResultSchema.parse({ loggedIn: true, cookiesStored: true, user: { id: 1, displayName: "M", username: "m" }, detail: "session valid", loginInProgress: false });
  ExtractResultSchema.parse({ result: "Extracted 12 cookies from chrome", cookiesStored: true, loginWindowOpened: false, loggedIn: true, loginInProgress: false });
});

test("post_comment: a failed write is outcome_unknown unless the site refused it (4xx)", () => {
  assert.equal(errorCode(writeError(new Error("HTTP 500: https://www.curseforge.com/api/v1/comments"))), "outcome_unknown");
  assert.equal(errorCode(writeError(new Error("page.evaluate: Timeout 30000ms exceeded"))), "outcome_unknown");
  assert.equal(errorCode(writeError(new Error("Unexpected token < in JSON at position 0"))), "outcome_unknown");
  assert.equal(errorCode(writeError(new Error("HTTP 408: x"))), "outcome_unknown");
  assert.equal(errorCode(writeError(new Error("HTTP 401: x"))), "not_logged_in");
  assert.equal(errorCode(writeError(new Error("HTTP 403: x"))), "cloudflare");
  assert.equal(errorCode(writeError(new Error("HTTP 429: x"))), "rate_limited");
  assert.equal(errorCode(writeError(new Error("HTTP 400: bad body"))), "error");
});
