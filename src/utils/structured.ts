// Machine-readable output (`format: "json"`): the full result as MCP `structuredContent`
// plus the same JSON as the text block. Text output stays the default and unchanged.
// No `outputSchema` is declared (the SDK would then require structuredContent on text
// calls too). Shapes: README → "Structured output"; zod schemas in src/tools/json-shapes.ts.

import { z } from "zod/v4";
import type { ToolResult } from "./types.js";

export const formatArg = z
  .enum(["text", "json"])
  .optional()
  .default("text")
  .describe('"json" = full untruncated machine-readable result (structuredContent); default "text"');

/** outcome_unknown: a write request was sent but its result is not known (timeout, 5xx,
 *  unreadable answer): it may have been saved. Callers read back instead of retrying. */
export type ErrorCode = "not_logged_in" | "cloudflare" | "not_found" | "disabled" | "rate_limited" | "invalid" | "outcome_unknown" | "error";

/** Error for a failed write request: an HTTP 4xx (except 408) is a refusal and keeps
 *  its own code; anything else (5xx, lost answer, unreadable body) is outcome_unknown. */
export function writeError(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  const st = /HTTP (\d{3})/.exec(m);
  const status = st ? Number(st[1]) : null;
  if (status !== null && status >= 400 && status < 500 && status !== 408) return e instanceof Error ? e : new Error(m);
  return new CodedError("outcome_unknown", `${m} (the request was sent: it may have been saved — read back before retrying)`);
}

export class CodedError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Machine code for any thrown error: explicit CodedError, else from the message. */
export function errorCode(e: unknown): ErrorCode {
  if (e instanceof CodedError) return e.code;
  const m = msgOf(e);
  if (/HTTP 401|Authentication required|No session cookies|not logged in/i.test(m)) return "not_logged_in";
  // www/authors answer 403 only for a Cloudflare challenge the browser did not pass.
  if (/HTTP 403|just a moment|cloudflare|challenge/i.test(m)) return "cloudflare";
  if (/HTTP 429|rate limit/i.test(m)) return "rate_limited";
  if (/HTTP 404|record not found|not found/i.test(m)) return "not_found";
  if (/disabled/i.test(m)) return "disabled";
  return "error";
}

export function jsonResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function jsonError(tool: string, e: unknown): ToolResult {
  const error = { code: errorCode(e), message: `${tool}: ${msgOf(e)}` };
  return { content: [{ type: "text", text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true };
}

/** Unix ms / s / ISO → ISO-8601 UTC, or null. */
export function isoUtc(d: string | number | null | undefined): string | null {
  if (d === null || d === undefined || d === "" || d === 0) return null;
  const date = typeof d === "number" ? new Date(d < 1e12 ? d * 1000 : d) : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
}
