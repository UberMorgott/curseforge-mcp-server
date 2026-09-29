// `format: "json"` result shapes (README → "Structured output"): pure mappers from the
// CFWidget / www.curseforge.com API responses + the zod schemas they satisfy (checked by
// the tests). Comment ids are strings; user/mod ids numbers; timestamps ISO-8601 UTC.

import { z } from "zod/v4";
import { stripHtml } from "../utils/helpers.js";
import { isoUtc } from "../utils/structured.js";

const iso = z.string().nullable();

// ── search_author / get_project (CFWidget) ───────────────────────

export const AuthorResultSchema = z.object({
  author: z.object({ id: z.number(), username: z.string() }),
  projects: z.array(z.object({ id: z.number(), name: z.string() })),
});

export function authorJson(d: any): z.infer<typeof AuthorResultSchema> {
  return {
    author: { id: Number(d.id), username: String(d.username ?? "") },
    projects: (d.projects ?? []).map((p: any) => ({ id: Number(p.id), name: String(p.name ?? "") })),
  };
}

export const ProjectResultSchema = z.object({
  id: z.number(),
  title: z.string(),
  summary: z.string(),
  game: z.string().nullable(),
  type: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: iso,
  downloads: z.number(),
  members: z.array(z.object({ id: z.number(), username: z.string(), title: z.string() })),
});

export function projectJson(p: any): z.infer<typeof ProjectResultSchema> {
  return {
    id: Number(p.id),
    title: String(p.title ?? p.name ?? ""),
    summary: String(p.summary ?? ""),
    game: p.game ?? null,
    type: p.type ?? null,
    url: p.urls?.curseforge ?? p.urls?.project ?? null,
    createdAt: isoUtc(p.created_at),
    downloads: Number(p.downloads?.total) || 0,
    members: (p.members ?? []).map((m: any) => ({ id: Number(m.id), username: String(m.username ?? ""), title: String(m.title ?? "") })),
  };
}

// ── get_comments ─────────────────────────────────────────────────

const CommentBase = {
  id: z.string(),
  parentId: z.string().nullable(),
  author: z.string(),
  authorId: z.number().nullable(),
  authorUsername: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  body: z.string(),
  bodyHtml: z.string(),
};
export const ReplySchema = z.object({ ...CommentBase, depth: z.number() });
export const ThreadSchema = z.object({ ...CommentBase, pinned: z.boolean(), replies: z.array(ReplySchema) });
export const CommentsResultSchema = z.object({
  modId: z.number(),
  page: z.number(),
  pages: z.number().nullable(),
  pageSize: z.number(),
  total: z.number().nullable(),
  comments: z.array(ThreadSchema),
});

function base(c: any) {
  const html = String(c.renderedHtml ?? c.body ?? "");
  return {
    id: String(c.id),
    parentId: c.parentId != null ? String(c.parentId) : null,
    author: String(c.author?.displayName || c.author?.username || "?"),
    authorId: c.author?.id != null ? Number(c.author.id) : null,
    authorUsername: c.author?.username ?? null,
    createdAt: isoUtc(c.datePosted),
    updatedAt: isoUtc(c.dateModified ?? c.dateEdited ?? null),
    // `text` is the site's own plain-text rendering; fall back to stripping the HTML.
    body: typeof c.text === "string" && c.text ? c.text.replace(/\r\n/g, "\n") : stripHtml(html),
    bodyHtml: html,
  };
}

/** Root threads; every descendant reply flattened depth-first (site order) with its parentId. */
export function commentsJson(modId: number, page: number, d: any): z.infer<typeof CommentsResultSchema> {
  const pageSize = Number(d.pagination?.pageSize) || 20;
  const total = d.pagination?.totalCount != null ? Number(d.pagination.totalCount) : null;
  const flat = (list: any[], depth: number): z.infer<typeof ReplySchema>[] =>
    (list ?? []).flatMap((r) => [{ ...base(r), depth }, ...flat(r.replies, depth + 1)]);
  return {
    modId,
    page,
    pages: total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null,
    pageSize,
    total,
    comments: (d.data ?? []).map((c: any) => ({ ...base(c), parentId: null, pinned: !!c.isPinned, replies: flat(c.replies, 1) })),
  };
}

// ── post_comment / session ───────────────────────────────────────

export const PostResultSchema = z.object({
  posted: z.boolean(),
  id: z.string().nullable(),
  parentId: z.string().nullable(),
  verified: z.boolean(),
});

/** Where the stored web session came from (null = none stored / unknown legacy file). */
export const SessionSourceSchema = z.enum(["browser", "window", "manual"]).nullable();

/** Path of the current / last sign-in of the server process. */
export const LoginViaSchema = z.enum(["browser-extract", "default-browser", "window"]).nullable();

export const SessionResultSchema = z.object({
  loggedIn: z.boolean(),
  cookiesStored: z.boolean(),
  user: z.object({ id: z.number().nullable(), displayName: z.string().nullable(), username: z.string().nullable() }).nullable(),
  detail: z.string(),
  loginInProgress: z.boolean(),
  sessionSource: SessionSourceSchema,
  sessionBrowser: z.string().nullable(),
  loginVia: LoginViaSchema,
  loginBrowser: z.string().nullable(),
});

export const ExtractResultSchema = z.object({
  result: z.string(),
  cookiesStored: z.boolean(),
  loginWindowOpened: z.boolean(),
  loggedIn: z.boolean(),
  loginInProgress: z.boolean(),
  sessionSource: SessionSourceSchema,
  sessionBrowser: z.string().nullable(),
  loginVia: LoginViaSchema,
  loginBrowser: z.string().nullable(),
});

export const LoginCancelResultSchema = z.object({ cancelled: z.boolean() });

export const LogoutResultSchema = z.object({
  loggedOut: z.literal(true),
  cookiesStored: z.literal(false),
});

const norm = (s: string) => stripHtml(s).replace(/^In reply to [^:]*:/i, "").replace(/\s+/g, " ").trim();

/** Read-back after post_comment: newest comment (any depth) whose text matches and whose
 *  parent is `parentId` (null = root). The site may prefix replies with "In reply to X:". */
export function findPosted(pages: any[], text: string, parentId: number | undefined): string | null {
  const want = norm(text);
  const all: any[] = [];
  const walk = (list: any[]) => (list ?? []).forEach((c) => (all.push(c), walk(c.replies)));
  pages.forEach((d) => walk(d.data));
  const hits = all.filter(
    (c) => (parentId === undefined ? c.parentId == null : Number(c.parentId) === parentId) && norm(String(c.text || c.body || "")) === want,
  );
  if (!hits.length) return null;
  return String(hits.map((c) => Number(c.id)).sort((a, b) => b - a)[0]);
}
