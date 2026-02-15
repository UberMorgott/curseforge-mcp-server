export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function compact(data: unknown): string {
  return JSON.stringify(data);
}

export function stripHtml(html: string): string {
  return html
    // Add line breaks for block elements before stripping tags
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|pre|hr)[^>]*>/gi, "\n")
    // Strip all remaining tags
    .replace(/<[^>]*>/g, "")
    // Decode HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Normalize whitespace: collapse spaces within lines, collapse 3+ newlines to 2
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, maxLen: number = 20000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... [truncated]";
}

const UA_PLATFORMS: Record<string, string> = {
  win32: "Windows NT 10.0; Win64; x64",
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  linux: "X11; Linux x86_64",
};
const platformUA = UA_PLATFORMS[process.platform] || UA_PLATFORMS.linux;
export const USER_AGENT = `Mozilla/5.0 (${platformUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;

export async function safeFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": USER_AGENT,
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${url}${body ? `\n${body.slice(0, 500)}` : ""}`,
    );
  }
  return response;
}

// ── Compact formatters for token efficiency ──

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtDate(d: string | Date | undefined): string {
  if (!d) return "?";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + "GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + "MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + "KB";
  return bytes + "B";
}

const RELEASE_LABELS: Record<number, string> = { 1: "release", 2: "beta", 3: "alpha" };

export function formatMod(m: any): string {
  const authors = m.authors?.map((a: any) => a.name || a).join(", ") || "";
  const cats = m.categories?.map((c: any) => c.name || c).join(", ") || "";
  let line = `[${m.id}] ${m.name} — ${fmtNum(m.downloadCount || 0)} downloads`;
  if (authors) line += ` | by ${authors}`;
  if (m.slug) line += `\n  slug: ${m.slug}`;
  if (cats) line += ` | ${cats}`;
  if (m.dateModified) line += ` | updated: ${fmtDate(m.dateModified)}`;
  if (m.summary) line += `\n  ${m.summary}`;
  return line;
}

export function formatModDetailed(m: any): string {
  const lines: string[] = [];
  lines.push(`${m.name} (ID: ${m.id})`);
  if (m.slug) lines.push(`slug: ${m.slug} | game: ${m.gameId}`);
  lines.push(`downloads: ${fmtNum(m.downloadCount || 0)} | rank: #${m.gamePopularityRank || "?"}`);
  if (m.authors?.length) lines.push(`authors: ${m.authors.map((a: any) => a.name || a).join(", ")}`);
  if (m.categories?.length) lines.push(`categories: ${m.categories.map((c: any) => c.name || c).join(", ")}`);
  if (m.summary) lines.push(`summary: ${m.summary}`);
  if (m.links) {
    const l = m.links;
    const urls = [l.websiteUrl, l.sourceUrl, l.issuesUrl, l.wikiUrl].filter(Boolean);
    if (urls.length) lines.push(`links: ${urls.join(" | ")}`);
  }
  if (m.logo?.thumbnailUrl) lines.push(`logo: ${m.logo.thumbnailUrl}`);
  lines.push(`created: ${fmtDate(m.dateCreated)} | updated: ${fmtDate(m.dateModified)} | released: ${fmtDate(m.dateReleased)}`);
  if (m.mainFileId) lines.push(`main file: ${m.mainFileId}`);
  if (m.latestFilesIndexes?.length) {
    const idx = m.latestFilesIndexes.map((f: any) =>
      `${f.gameVersion || "?"} [${RELEASE_LABELS[f.releaseType] || f.releaseType}] fileId:${f.fileId}`
    );
    lines.push(`latest: ${idx.join(", ")}`);
  }
  return lines.join("\n");
}

export function formatFile(f: any): string {
  const rt = RELEASE_LABELS[f.releaseType] || f.releaseType || "?";
  const versions = f.gameVersions?.join(", ") || "";
  let line = `[${f.id}] ${f.displayName || f.fileName} (${rt}, ${fmtSize(f.fileLength || 0)})`;
  if (f.downloadCount) line += ` — ${fmtNum(f.downloadCount)} downloads`;
  if (f.fileDate) line += ` | ${fmtDate(f.fileDate)}`;
  if (versions) line += `\n  versions: ${versions}`;
  if (f.downloadUrl) line += `\n  url: ${f.downloadUrl}`;
  return line;
}

export function formatComment(c: any): string {
  const author = c.author?.displayName || c.author?.username || "?";
  const date = c.datePosted ? fmtDate(new Date(c.datePosted)) : "?";
  const text = (c.text || c.body || "").slice(0, 200);
  return `[${c.id}] ${author} (${date}): ${text}`;
}

export function formatCommentThread(c: any): string {
  const author = c.author?.displayName || c.author?.username || "?";
  const date = c.datePosted ? fmtDate(new Date(c.datePosted)) : "?";
  const text = (c.text || c.body || "").slice(0, 300);
  const replies: any[] = c.replies || [];

  const noReplies = replies.length === 0 ? " [NO REPLIES]" : "";
  let result = `[${c.id}] ${author} (${date})${noReplies}: ${text}`;

  for (const r of replies) {
    const rAuthor = r.author?.displayName || r.author?.username || "?";
    const rDate = r.datePosted ? fmtDate(new Date(r.datePosted)) : "?";
    const rText = (r.text || r.body || "").slice(0, 200);
    result += `\n  └─ [${r.id}] ${rAuthor} (${rDate}): ${rText}`;
  }

  return result;
}

export function formatProject(p: any): string {
  const dl = p.downloads?.total ? ` — ${fmtNum(p.downloads.total)} downloads` : "";
  let line = `[${p.id}] ${p.title || p.name}${dl}`;
  if (p.game) line += ` | ${p.game}`;
  if (p.type) line += `/${p.type}`;
  if (p.summary) line += `\n  ${p.summary}`;
  return line;
}

export function formatGame(g: any): string {
  return `[${g.id}] ${g.name} (${g.slug || "?"})`;
}

export function formatCategory(c: any): string {
  return `[${c.id}] ${c.name} (slug: ${c.slug}, class: ${c.classId || "?"}, parent: ${c.parentCategoryId || "root"})`;
}
