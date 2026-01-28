import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const packageJsonPath = join(rootDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const version = typeof packageJson.version === "string" ? packageJson.version : "unknown";

const sourcePath = join(rootDir, "lib", "oauth-success.html");
const sourceHtml = readFileSync(sourcePath, "utf-8");
const renderedHtml = sourceHtml.replace(/__PLUGIN_VERSION__/g, version);

const destDir = join(rootDir, "dist", "lib");
mkdirSync(destDir, { recursive: true });
const destPath = join(destDir, "oauth-success.html");
writeFileSync(destPath, renderedHtml, "utf-8");
