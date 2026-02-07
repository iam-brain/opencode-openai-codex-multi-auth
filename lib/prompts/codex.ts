import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import type { CacheMetadata, GitHubRelease } from "../types.js";
import { getOpencodeCacheDir, migrateLegacyCacheFiles } from "../paths.js";
import { MODEL_FAMILIES, type ModelFamily } from "../constants.js";
import { logDebug, logWarn } from "../logger.js";

export { MODEL_FAMILIES, type ModelFamily };

const GITHUB_API_RELEASES =
	"https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES =
	"https://github.com/openai/codex/releases/latest";
const GITHUB_CORE_PATH = "codex-rs/core";
const CACHE_DIR = getOpencodeCacheDir();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PROMPT_FILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Static fallback prompt file mapping for each model family.
 * Used when dynamic discovery fails or for immediate startup.
 */
const FALLBACK_PROMPT_FILES: Record<ModelFamily, string> = {
	"gpt-5.3-codex": "gpt-5.2-codex_prompt.md",
	"gpt-5.2-codex": "gpt-5.2-codex_prompt.md",
	"codex-max": "gpt-5.1-codex-max_prompt.md",
	codex: "gpt_5_codex_prompt.md",
	"gpt-5.2": "gpt_5_2_prompt.md",
	"gpt-5.1": "gpt_5_1_prompt.md",
};

// Dynamic prompt file mapping cache (discovered from GitHub)
let discoveredPromptFiles: Map<string, string> | null = null;
let promptFilesDiscoveredAt: number | null = null;

/**
 * Prompt file name patterns to search for in codex-rs/core.
 * Patterns: *_prompt.md, prompt*.md, prompt.md
 */
const PROMPT_FILE_PATTERNS = [
	/_prompt\.md$/i,      // e.g., gpt_5_3_codex_prompt.md
	/^prompt.*\.md$/i,    // e.g., prompt_gpt5.md
	/^prompt\.md$/i,      // fallback prompt.md
];

/**
 * Normalize a model family to a prompt file search pattern.
 * Converts "gpt-5.3-codex" → ["gpt_5_3_codex", "gpt-5.3-codex", "gpt_5.3_codex"]
 */
function modelFamilyToPromptPatterns(family: ModelFamily): string[] {
	const patterns: string[] = [];
	const normalized = family.toLowerCase();
	
	// Add underscored version (gpt-5.3-codex → gpt_5_3_codex)
	patterns.push(normalized.replace(/[-.]/g, "_"));
	// Add hyphenated version
	patterns.push(normalized.replace(/\./g, "_"));
	// Add mixed version
	patterns.push(normalized);
	
	return patterns;
}

/**
 * Match a prompt filename to a model family.
 * Returns the model family if matched, otherwise null.
 */
function matchPromptFileToFamily(filename: string): ModelFamily | null {
	const lower = filename.toLowerCase();
	if (!lower.endsWith("_prompt.md") && !lower.startsWith("prompt")) {
		return null;
	}
	
	// Extract the model identifier from the filename
	const base = lower.replace(/_prompt\.md$/, "").replace(/^prompt_?/, "").replace(/\.md$/, "");
	if (!base) return null;
	
	// Try to match against known model families
	for (const family of MODEL_FAMILIES) {
		const patterns = modelFamilyToPromptPatterns(family);
		for (const pattern of patterns) {
			if (base === pattern || base.includes(pattern) || pattern.includes(base)) {
				return family;
			}
		}
	}
	
	return null;
}

/**
 * Discover prompt files from GitHub repository.
 * Fetches the file listing from codex-rs/core and maps them to model families.
 */
async function discoverPromptFilesFromGitHub(
	tag: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
	const discovered = new Map<string, string>();
	
	try {
		// Use GitHub API to list files in the directory
		const apiUrl = `https://api.github.com/repos/openai/codex/contents/${GITHUB_CORE_PATH}?ref=${tag}`;
		const response = await fetchImpl(apiUrl, {
			headers: {
				Accept: "application/vnd.github.v3+json",
				"User-Agent": "opencode-openai-codex-plugin",
			},
		});
		
		if (!response.ok) {
			logDebug(`Failed to list GitHub directory: HTTP ${response.status}`);
			return discovered;
		}
		
		const files = (await response.json()) as Array<{ name: string; type: string }>;
		const promptFiles = files
			.filter((f) => f.type === "file")
			.filter((f) => PROMPT_FILE_PATTERNS.some((p) => p.test(f.name)))
			.map((f) => f.name);
		
		logDebug(`Discovered prompt files from GitHub: ${promptFiles.join(", ")}`);
		
		// Map discovered files to model families
		for (const file of promptFiles) {
			const family = matchPromptFileToFamily(file);
			if (family && !discovered.has(family)) {
				discovered.set(family, file);
			}
		}
		
		// Also store raw filenames for direct lookup
		for (const file of promptFiles) {
			if (!discovered.has(file)) {
				discovered.set(file, file);
			}
		}
	} catch (error) {
		logDebug("Failed to discover prompt files from GitHub", error);
	}
	
	return discovered;
}

/**
 * Get the prompt file for a model family.
 * Uses dynamic discovery with fallback to static mapping.
 */
function getPromptFileForFamily(modelFamily: ModelFamily): string {
	// Check dynamic cache first (if fresh)
	if (
		discoveredPromptFiles &&
		promptFilesDiscoveredAt &&
		Date.now() - promptFilesDiscoveredAt < PROMPT_FILE_CACHE_TTL_MS
	) {
		const discovered = discoveredPromptFiles.get(modelFamily);
		if (discovered) return discovered;
	}
	
	// Fall back to static mapping
	return FALLBACK_PROMPT_FILES[modelFamily];
}

/**
 * Cache file mapping for each model family
 */
const CACHE_FILES: Record<ModelFamily, string> = {
	"gpt-5.3-codex": "gpt-5.3-codex-instructions.md",
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
const IN_MEMORY_INSTRUCTIONS = new Map<ModelFamily, { value: string }>();

const LOCK_OPTIONS = {
	stale: 10_000,
	retries: {
		retries: 5,
		minTimeout: 100,
		maxTimeout: 1000,
		factor: 2,
	},
	realpath: false,
};

function ensureCacheMigrated(): void {
	if (cacheMigrated) return;
	migrateLegacyCacheFiles(LEGACY_CACHE_FILES);
	cacheMigrated = true;
}

function readInMemoryInstructions(modelFamily: ModelFamily): string | null {
	const entry = IN_MEMORY_INSTRUCTIONS.get(modelFamily);
	return entry?.value ?? null;
}

function writeInMemoryInstructions(modelFamily: ModelFamily, value: string): void {
	IN_MEMORY_INSTRUCTIONS.set(modelFamily, { value });
}

function readCacheMetadata(cacheMetaFile: string): CacheMetadata | null {
	try {
		if (!existsSync(cacheMetaFile)) return null;
		const parsed = JSON.parse(readFileSync(cacheMetaFile, "utf8")) as CacheMetadata;
		if (!parsed || typeof parsed.tag !== "string") return null;
		if (!Number.isFinite(parsed.lastChecked)) return null;
		if (typeof parsed.url !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeCacheAtomically(
	cacheFile: string,
	cacheMetaFile: string,
	instructions: string,
	metadata: CacheMetadata,
): Promise<void> {
	if (!existsSync(CACHE_DIR)) {
		mkdirSync(CACHE_DIR, { recursive: true });
	}
	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(CACHE_DIR, LOCK_OPTIONS);
		const tmpCachePath = `${cacheFile}.${randomBytes(6).toString("hex")}.tmp`;
		const tmpMetaPath = `${cacheMetaFile}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeFileSync(tmpCachePath, instructions, "utf8");
			writeFileSync(tmpMetaPath, JSON.stringify(metadata), "utf8");
			renameSync(tmpCachePath, cacheFile);
			renameSync(tmpMetaPath, cacheMetaFile);
		} catch (error) {
			try {
				unlinkSync(tmpCachePath);
			} catch { }
			try {
				unlinkSync(tmpMetaPath);
			} catch { }
			throw error;
		}
	} finally {
		if (release) {
			await release().catch(() => undefined);
		}
	}
}

/**
 * Determine the model family based on the normalized model name
 * @param normalizedModel - The normalized model name (e.g., "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1")
 * @returns The model family for prompt selection
 */
export function getModelFamily(normalizedModel: string): ModelFamily {
	// Order matters - check more specific patterns first
	if (
		normalizedModel.includes("gpt-5.3-codex") ||
		normalizedModel.includes("gpt 5.3 codex")
	) {
		return "gpt-5.3-codex";
	}
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
	const inMemory = readInMemoryInstructions(modelFamily);
	if (inMemory) return inMemory;
	const promptFile = getPromptFileForFamily(modelFamily);
	const cacheFile = join(CACHE_DIR, CACHE_FILES[modelFamily]);
	const cacheMetaFile = join(
		CACHE_DIR,
		`${CACHE_FILES[modelFamily].replace(".md", "-meta.json")}`,
	);

	try {
		// Load cached metadata (includes ETag, tag, and lastChecked timestamp)
		const metadata = readCacheMetadata(cacheMetaFile);
		let cachedETag: string | null = metadata?.etag ?? null;
		let cachedTag: string | null = metadata?.tag ?? null;
		let cachedTimestamp: number | null = metadata?.lastChecked ?? null;

		// Rate limit protection: If cache is less than 15 minutes old, use it
		if (
			cachedTimestamp &&
			Date.now() - cachedTimestamp < CACHE_TTL_MS &&
			existsSync(cacheFile)
		) {
			const instructions = readFileSync(cacheFile, "utf8");
			writeInMemoryInstructions(modelFamily, instructions);
			return instructions;
		}

		// Get the latest release tag (only if cache is stale or missing)
		const latestTag = await getLatestReleaseTag(fetch);
		
		// Try to discover prompt files dynamically (updates cache for future calls)
		if (!discoveredPromptFiles || !promptFilesDiscoveredAt || 
		    Date.now() - promptFilesDiscoveredAt > PROMPT_FILE_CACHE_TTL_MS) {
			try {
				discoveredPromptFiles = await discoverPromptFilesFromGitHub(latestTag, fetch);
				promptFilesDiscoveredAt = Date.now();
			} catch {
				// Discovery failure is non-fatal; continue with fallback
			}
		}
		
		// Re-resolve prompt file after discovery (may have found a new one)
		const resolvedPromptFile = getPromptFileForFamily(modelFamily);
		const CODEX_INSTRUCTIONS_URL = `https://raw.githubusercontent.com/openai/codex/${latestTag}/${GITHUB_CORE_PATH}/${resolvedPromptFile}`;

		// If tag changed, we need to fetch new instructions
		if (cachedTag !== latestTag) {
			cachedETag = null; // Force re-fetch
		}

		// Make conditional request with If-None-Match header
		const headers: Record<string, string> = {};
		if (cachedETag) {
			headers["If-None-Match"] = cachedETag;
		}

		let response = await fetch(CODEX_INSTRUCTIONS_URL, { headers });

		// 304 Not Modified - our cached version is still current
		if (response.status === 304) {
			if (existsSync(cacheFile)) {
				const instructions = readFileSync(cacheFile, "utf8");
				writeInMemoryInstructions(modelFamily, instructions);
				return instructions;
			}
			response = await fetch(CODEX_INSTRUCTIONS_URL);
		}
		
		// 404 Not Found - try fallback to generic prompt.md
		if (response.status === 404 && resolvedPromptFile !== "prompt.md") {
			logDebug(`Prompt file ${resolvedPromptFile} not found; trying prompt.md fallback`);
			const fallbackUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/${GITHUB_CORE_PATH}/prompt.md`;
			response = await fetch(fallbackUrl);
		}

		// 200 OK - new content or first fetch
		if (response.ok) {
			const instructions = await response.text();
			const newETag = response.headers.get("etag");
			await writeCacheAtomically(cacheFile, cacheMetaFile, instructions, {
				etag: newETag,
				tag: latestTag,
				lastChecked: Date.now(),
				url: CODEX_INSTRUCTIONS_URL,
			});
			writeInMemoryInstructions(modelFamily, instructions);
			return instructions;
		}

		throw new Error(`HTTP ${response.status}`);
	} catch (error) {
		const err = error as Error;
		logWarn(
			`[openai-codex-plugin] Failed to fetch ${modelFamily} instructions from GitHub:`,
			err.message,
		);

		// Try to use cached version even if stale
		if (existsSync(cacheFile)) {
			logWarn(
				`[openai-codex-plugin] Using cached ${modelFamily} instructions`,
			);
			const instructions = readFileSync(cacheFile, "utf8");
			writeInMemoryInstructions(modelFamily, instructions);
			return instructions;
		}

		// Fall back to bundled version (use codex-instructions.md as default)
		logWarn(
			`[openai-codex-plugin] Falling back to bundled instructions for ${modelFamily}`,
		);
		const bundled = readFileSync(join(__dirname, "codex-instructions.md"), "utf8");
		writeInMemoryInstructions(modelFamily, bundled);
		return bundled;
	}
}

export async function warmCodexInstructions(): Promise<void> {
	ensureCacheMigrated();
	const tasks = MODEL_FAMILIES.map(async (modelFamily) => {
		try {
			if (readInMemoryInstructions(modelFamily)) return;
			const cacheFile = join(CACHE_DIR, CACHE_FILES[modelFamily]);
			const cacheMetaFile = join(
				CACHE_DIR,
				`${CACHE_FILES[modelFamily].replace(".md", "-meta.json")}`,
			);
			const metadata = readCacheMetadata(cacheMetaFile);
			const hasCacheFile = existsSync(cacheFile);
			const isFresh =
				metadata?.lastChecked &&
				Date.now() - metadata.lastChecked < CACHE_TTL_MS;

			if (isFresh && hasCacheFile) {
				const instructions = readFileSync(cacheFile, "utf8");
				writeInMemoryInstructions(modelFamily, instructions);
				return;
			}
			if (!metadata && !hasCacheFile) return;
			await getCodexInstructions(modelFamily);
		} catch {
			// Warm failures should not block startup.
		}
	});
	await Promise.allSettled(tasks);
}
