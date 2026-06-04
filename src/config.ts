import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

export interface Config {
  curseforgeApiKey: string;
  curseforgeAuthorToken: string;
  uploadDir: string; // optional — if set, confines upload_file reads to this directory
  authDir: string;
  cookiesPath: string;
}

export function loadConfig(): Config {
  const authDir = path.resolve(__dirname, "..", ".auth");
  return {
    curseforgeApiKey: process.env.CURSEFORGE_API_KEY || "",
    curseforgeAuthorToken: process.env.CURSEFORGE_AUTHOR_TOKEN || "",
    uploadDir: process.env.CURSEFORGE_UPLOAD_DIR || "",
    authDir,
    cookiesPath: path.resolve(authDir, "cookies.json"),
  };
}
