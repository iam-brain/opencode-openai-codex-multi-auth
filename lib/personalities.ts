import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getOpencodeConfigDir } from "./paths.js";
import { logDebug } from "./logger.js";

type CachedPersonality = {
	content: string;
	mtimeMs: number;
};

const PERSONALITY_DIR_NAME = "Personalities";
const PERSONALITY_CACHE = new Map<string, CachedPersonality>();
const PERSONALITY_CACHE_MARKER = "<!-- opencode personality cache -->";

function resolveProjectPersonalityDir(projectRoot: string): string {
	return join(projectRoot, ".opencode", PERSONALITY_DIR_NAME);
}

function resolveGlobalPersonalityDir(): string {
	return join(getOpencodeConfigDir(), PERSONALITY_DIR_NAME);
}

function resolvePersonalityFile(
	directory: string,
	personality: string,
): string | null {
	if (!existsSync(directory)) return null;
	const normalized = personality.trim();
	if (!normalized) return null;
	if (!isSafePersonalityKey(normalized)) return null;
	const direct = join(directory, `${normalized}.md`);
	if (existsSync(direct)) return direct;
	const lowerTarget = `${normalized.toLowerCase()}.md`;
	try {
		const entries = readdirSync(directory);
		for (const entry of entries) {
			if (entry.toLowerCase() === lowerTarget) {
				return join(directory, entry);
			}
		}
	} catch {
		return null;
	}
	return null;
}

function isSafePersonalityKey(personality: string): boolean {
	return !(
		personality.includes("/") ||
		personality.includes("\\") ||
		personality.includes("..")
	);
}

function readPersonalityFile(filePath: string): string | null {
	try {
		const stats = statSync(filePath);
		const cached = PERSONALITY_CACHE.get(filePath);
		if (cached && cached.mtimeMs === stats.mtimeMs) return cached.content;
		const content = readFileSync(filePath, "utf8");
		const normalized = content.startsWith(PERSONALITY_CACHE_MARKER)
			? content.slice(PERSONALITY_CACHE_MARKER.length).trimStart()
			: content;
		PERSONALITY_CACHE.set(filePath, { content: normalized, mtimeMs: stats.mtimeMs });
		return normalized;
	} catch (error) {
		logDebug("Failed to read personality file", error);
		return null;
	}
}

export function resolveCustomPersonalityDescription(
	personality: string,
	projectRoot: string = process.cwd(),
): string | null {
	const localDir = resolveProjectPersonalityDir(projectRoot);
	const globalDir = resolveGlobalPersonalityDir();

	const localFile = resolvePersonalityFile(localDir, personality);
	if (localFile) {
		const content = readPersonalityFile(localFile);
		if (content) return content;
	}

	const globalFile = resolvePersonalityFile(globalDir, personality);
	if (globalFile) {
		const content = readPersonalityFile(globalFile);
		if (content) return content;
	}

	return null;
}

export const __internal = {
	resolveProjectPersonalityDir,
	resolveGlobalPersonalityDir,
	resolvePersonalityFile,
};
