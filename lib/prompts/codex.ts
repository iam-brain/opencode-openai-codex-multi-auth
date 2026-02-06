import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CacheMetadata, GitHubRelease } from "../types.js";
import { getOpencodeCacheDir, migrateLegacyCacheFiles } from "../paths.js";
import { MODEL_FAMILIES, type ModelFamily } from "../constants.js";

export { MODEL_FAMILIES, type ModelFamily };

const GITHUB_API_RELEASES =
	"https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES =
	"https://github.com/openai/codex/releases/latest";
const CACHE_DIR = getOpencodeCacheDir();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Prompt file mapping for each model family
 * Based on codex-rs/core/src/model_family.rs logic
 */
const PROMPT_FILES: Record<ModelFamily, string> = {
	"gpt-5.2-codex": "gpt-5.2-codex_prompt.md",
	"codex-max": "gpt-5.1-codex-max_prompt.md",
	codex: "gpt_5_codex_prompt.md",
	"gpt-5.2": "gpt_5_2_prompt.md",
	"gpt-5.1": "gpt_5_1_prompt.md",
};

/**
 * Cache file mapping for each model family
 */
const CACHE_FILES: Record<ModelFamily, string> = {
	"gpt-5.2-codex": "gpt-5.2-codex-instructions.md",
	"codex-max": "codex-max-instructions.md",
	codex: "codex-instructions.md",
	"gpt-5.2": "gpt-5.2-instructions.md",
	"gpt-5.1": "gpt-5.1-instructions.md",
};

const CACHE_META_FILES = Object.values(CACHE_FILES).map((file) =>
	file.replace(".md", "-meta.json"),
);
const LEGACY_CACHE_FILES = [...Object.values(CACHE_FILES), ...CACHE_META_FILES];
let cacheMigrated = false;

function ensureCacheMigrated(): void {
	if (cacheMigrated) return;
	migrateLegacyCacheFiles(LEGACY_CACHE_FILES);
	cacheMigrated = true;
}

/**
 * Determine the model family based on the normalized model name
 * @param normalizedModel - The normalized model name (e.g., "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1")
 * @returns The model family for prompt selection
 */
export function getModelFamily(normalizedModel: string): ModelFamily {
	// Order matters - check more specific patterns first
	if (
		normalizedModel.includes("gpt-5.2-codex") ||
		normalizedModel.includes("gpt 5.2 codex")
	) {
		return "gpt-5.2-codex";
	}
	if (normalizedModel.includes("codex-max")) {
		return "codex-max";
	}
	if (
		normalizedModel.includes("codex") ||
		normalizedModel.startsWith("codex-")
	) {
		return "codex";
	}
	if (normalizedModel.includes("gpt-5.2")) {
		return "gpt-5.2";
	}
	return "gpt-5.1";
}

/**
 * Get the latest release tag from GitHub
 * @returns Release tag name (e.g., "rust-v0.43.0")
 */
export async function getLatestReleaseTag(
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	try {
		const response = await fetchImpl(GITHUB_API_RELEASES);
		if (response.ok) {
			const data = (await response.json()) as GitHubRelease;
			if (data.tag_name) {
				return data.tag_name;
			}
		}
	} catch {
	}

	const htmlResponse = await fetchImpl(GITHUB_HTML_RELEASES);
	if (!htmlResponse.ok) {
		throw new Error(
			`Failed to fetch latest release: ${htmlResponse.status}`,
		);
	}

	const finalUrl = htmlResponse.url;
	if (finalUrl) {
		const parts = finalUrl.split("/tag/");
		const last = parts[parts.length - 1];
		if (last && !last.includes("/")) {
			return last;
		}
	}

	const html = await htmlResponse.text();
	const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/);
	if (match && match[1]) {
		return match[1];
	}

	throw new Error("Failed to determine latest release tag from GitHub");
}

/**
 * Fetch Codex instructions from GitHub with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 * Always fetches from the latest release tag, not main branch
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 *
 * @param normalizedModel - The normalized model name (optional, defaults to "gpt-5.1-codex" for backwards compatibility)
 * @returns Codex instructions for the specified model family
 */
export async function getCodexInstructions(
	normalizedModel = "gpt-5.1-codex",
): Promise<string> {
	ensureCacheMigrated();
	const modelFamily = getModelFamily(normalizedModel);
	const promptFile = PROMPT_FILES[modelFamily];
	const cacheFile = join(CACHE_DIR, CACHE_FILES[modelFamily]);
	const cacheMetaFile = join(
		CACHE_DIR,
		`${CACHE_FILES[modelFamily].replace(".md", "-meta.json")}`,
	);

	try {
		// Load cached metadata (includes ETag, tag, and lastChecked timestamp)
		let cachedETag: string | null = null;
		let cachedTag: string | null = null;
		let cachedTimestamp: number | null = null;

		if (existsSync(cacheMetaFile)) {
			const metadata = JSON.parse(
				readFileSync(cacheMetaFile, "utf8"),
			) as CacheMetadata;
			cachedETag = metadata.etag;
			cachedTag = metadata.tag;
			cachedTimestamp = metadata.lastChecked;
		}

		// Rate limit protection: If cache is less than 15 minutes old, use it
		const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
		if (
			cachedTimestamp &&
			Date.now() - cachedTimestamp < CACHE_TTL_MS &&
			existsSync(cacheFile)
		) {
			return readFileSync(cacheFile, "utf8");
		}

		// Get the latest release tag (only if cache is stale or missing)
		const latestTag = await getLatestReleaseTag(fetch);
		const CODEX_INSTRUCTIONS_URL = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`;

		// If tag changed, we need to fetch new instructions
		if (cachedTag !== latestTag) {
			cachedETag = null; // Force re-fetch
		}

		// Make conditional request with If-None-Match header
		const headers: Record<string, string> = {};
		if (cachedETag) {
			headers["If-None-Match"] = cachedETag;
		}

		const response = await fetch(CODEX_INSTRUCTIONS_URL, { headers });

		// 304 Not Modified - our cached version is still current
		if (response.status === 304) {
			if (existsSync(cacheFile)) {
				return readFileSync(cacheFile, "utf8");
			}
			// Cache file missing but GitHub says not modified - fall through to re-fetch
		}

		// 200 OK - new content or first fetch
		if (response.ok) {
			const instructions = await response.text();
			const newETag = response.headers.get("etag");

			// Create cache directory if it doesn't exist
			if (!existsSync(CACHE_DIR)) {
				mkdirSync(CACHE_DIR, { recursive: true });
			}

			// Cache the instructions with ETag and tag (verbatim from GitHub)
			writeFileSync(cacheFile, instructions, "utf8");
			writeFileSync(
				cacheMetaFile,
				JSON.stringify({
					etag: newETag,
					tag: latestTag,
					lastChecked: Date.now(),
					url: CODEX_INSTRUCTIONS_URL,
				} satisfies CacheMetadata),
				"utf8",
			);

			return instructions;
		}

		throw new Error(`HTTP ${response.status}`);
	} catch (error) {
		const err = error as Error;
		console.error(
			`[openai-codex-plugin] Failed to fetch ${modelFamily} instructions from GitHub:`,
			err.message,
		);

		// Try to use cached version even if stale
		if (existsSync(cacheFile)) {
			console.error(
				`[openai-codex-plugin] Using cached ${modelFamily} instructions`,
			);
			return readFileSync(cacheFile, "utf8");
		}

		// Fall back to bundled version (use codex-instructions.md as default)
		console.error(
			`[openai-codex-plugin] Falling back to bundled instructions for ${modelFamily}`,
		);
		return readFileSync(join(__dirname, "codex-instructions.md"), "utf8");
	}
}
