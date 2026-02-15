export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface UploadMetadata {
  changelog?: string;
  changelogType?: "text" | "html" | "markdown";
  displayName?: string;
  parentFileID?: number;
  gameVersions: number[];
  releaseType: "alpha" | "beta" | "release";
  relations?: {
    projects: Array<{
      slug: string;
      type:
        | "embeddedLibrary"
        | "incompatible"
        | "optionalDependency"
        | "requiredDependency"
        | "tool";
    }>;
  };
}

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export function success(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function error(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}
