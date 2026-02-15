import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

export interface Config {
  curseforgeApiKey: string;
  curseforgeAuthorToken: string;
  curseforgeGameSlug: string; // optional — used as default for upload API
  authDir: string;
  cookiesPath: string;
}

export function loadConfig(): Config {
  const authDir = path.resolve(__dirname, "..", ".auth");
  return {
    curseforgeApiKey: process.env.CURSEFORGE_API_KEY || "",
    curseforgeAuthorToken: process.env.CURSEFORGE_AUTHOR_TOKEN || "",
    curseforgeGameSlug: process.env.CURSEFORGE_GAME_SLUG || "",
    authDir,
    cookiesPath: path.resolve(authDir, "cookies.json"),
  };
}
