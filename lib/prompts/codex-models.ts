import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import type { ConfigOptions } from "../types.js";
import {
	CODEX_BASE_URL,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	URL_PATHS,
} from "../constants.js";
import { getOpencodeCacheDir } from "../paths.js";
import { logDebug, logWarn } from "../logger.js";
import { getLatestReleaseTag } from "./codex.js";

type PersonalityOption = "none" | "friendly" | "pragmatic";

interface ModelInstructionsVariables {
	personality?: string | null;
	personality_default?: string | null;
	personality_friendly?: string | null;
	personality_pragmatic?: string | null;
	personalities?: Record<string, string | null> | null;
}

interface ModelMessages {
	instructions_template?: string | null;
	instructions_variables?: ModelInstructionsVariables | null;
}

interface ModelInfo {
	slug: string;
	model_messages?: ModelMessages | null;
	base_instructions?: string | null;
	apply_patch_tool_type?: string | null;
	supported_reasoning_levels?: Array<{ effort?: string }> | null;
	default_reasoning_level?: string | null;
	supports_reasoning_summaries?: boolean | null;
	reasoning_summary_format?: string | null;
	support_verbosity?: boolean | null;
	default_verbosity?: string | null;
}

interface ModelsResponse {
	models: ModelInfo[];
}

interface ModelsCache {
	fetchedAt: number;
	source: "server" | "github";
	models: ModelInfo[];
	etag?: string | null;
}

export interface CodexModelRuntimeDefaults {
	onlineDefaultPersonality?: PersonalityOption;
	personalityMessages?: Record<string, string>;
	instructionsTemplate?: string;
	baseInstructions?: string;
	applyPatchToolType?: string;
	staticDefaultPersonality: PersonalityOption;
	defaultReasoningEffort?: string;
	supportedReasoningEfforts?: string[];
	supportsReasoningSummaries?: boolean;
	reasoningSummaryFormat?: string;
	supportsVerbosity?: boolean;
	defaultVerbosity?: string;
}

export interface ModelsFetchOptions {
	accessToken?: string;
	accountId?: string;
	forceRefresh?: boolean;
	fetchImpl?: typeof fetch;
}

const CACHE_DIR = getOpencodeCacheDir();
const MODELS_CACHE_FILE_BASE = join(CACHE_DIR, "codex-models-cache");
const CLIENT_VERSION_CACHE_FILE = join(CACHE_DIR, "codex-client-version.json");
const MODELS_FETCH_TIMEOUT_MS = 5_000;
const MODELS_CACHE_TTL_MS = 15 * 60 * 1000;
const MODELS_SERVER_RETRY_BACKOFF_MS = 60 * 1000;
const MODELS_SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour hard limit for session cache
const CLIENT_VERSION_TTL_MS = 60 * 60 * 1000;
const STATIC_DEFAULT_PERSONALITY: PersonalityOption = "none";
const EFFORT_SUFFIX_REGEX = /-(none|minimal|low|medium|high|xhigh)$/i;
const PERSONALITY_VALUES = new Set<PersonalityOption>([
	"none",
	"friendly",
	"pragmatic",
]);
const SUPPORTED_EFFORTS = new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
const STATIC_TEMPLATE_FILES = ["opencode-modern.json", "opencode-legacy.json"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATIC_TEMPLATE_DEFAULTS = new Map<string, Map<string, ConfigOptions>>();
// In-memory cache is now scoped by accountId (null = unauthenticated/shared)
const inMemoryModelsCacheByAccount = new Map<string | null, ModelsCache>();
const lastServerAttemptByAuth = new Map<string, number>();
let cachedClientVersion: string | null = null;
let cachedClientVersionAt: number | null = null;

/**
 * Get cache file path scoped to account identity.
 * Pro/Enterprise users may have access to different models (e.g., gpt-5.2-pro).
 */
function getModelsCacheFile(accountId?: string): string {
	if (!accountId) return `${MODELS_CACHE_FILE_BASE}.json`;
	// Use first 16 chars of accountId hash to avoid path issues
	const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16);
	return `${MODELS_CACHE_FILE_BASE}-${sanitized}.json`;
}

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

function normalizeModelSlug(model: string): string {
	return model.toLowerCase().trim();
}

function stripEffortSuffix(model: string): string {
	return model.replace(EFFORT_SUFFIX_REGEX, "");
}

function normalizePersonalityValue(value: unknown): PersonalityOption | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (!PERSONALITY_VALUES.has(normalized as PersonalityOption)) return undefined;
	return normalized as PersonalityOption;
}

function extractSemver(tag: string): string | null {
	const match = tag.match(/(\d+\.\d+\.\d+)/);
	return match?.[1] ?? null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractPersonalityMessages(
	instructionsVariables?: ModelInstructionsVariables | null,
): Record<string, string> {
	const messages: Record<string, string> = {};
	const personalities = instructionsVariables?.personalities;
	if (isObjectRecord(personalities)) {
		for (const [key, value] of Object.entries(personalities)) {
			if (typeof value !== "string") continue;
			const normalizedKey = key.trim().toLowerCase();
			if (!normalizedKey) continue;
			messages[normalizedKey] = value;
		}
	}

	if (
		typeof instructionsVariables?.personality_default === "string" &&
		messages.default === undefined
	) {
		messages.default = instructionsVariables.personality_default;
	}
	if (
		typeof instructionsVariables?.personality_friendly === "string" &&
		messages.friendly === undefined
	) {
		messages.friendly = instructionsVariables.personality_friendly;
	}
	if (
		typeof instructionsVariables?.personality_pragmatic === "string" &&
		messages.pragmatic === undefined
	) {
		messages.pragmatic = instructionsVariables.personality_pragmatic;
	}

	return messages;
}

async function resolveCodexClientVersion(fetchImpl?: typeof fetch): Promise<string> {
	if (cachedClientVersion && cachedClientVersionAt) {
		if (Date.now() - cachedClientVersionAt < CLIENT_VERSION_TTL_MS) {
			return cachedClientVersion;
		}
	}
	const cachedFile = readClientVersionCache();
	if (cachedFile?.version) {
		cachedClientVersion = cachedFile.version;
		cachedClientVersionAt = cachedFile.fetchedAt;
	}
	const impl = fetchImpl ?? fetch;
	try {
		const tag = await getLatestReleaseTag(impl);
		const semver = extractSemver(tag);
		if (semver) {
			cachedClientVersion = semver;
			cachedClientVersionAt = Date.now();
			writeClientVersionCache(semver);
			return semver;
		}
		logWarn(`Unrecognized Codex release tag for client_version: ${tag}`);
	} catch (error) {
		logDebug("Failed to resolve Codex client_version from GitHub", error);
	}
	return cachedClientVersion ?? "1.0.0";
}

function readModelsCache(accountId?: string): ModelsCache | null {
	const cacheFile = getModelsCacheFile(accountId);
	try {
		if (!existsSync(cacheFile)) return null;
		const raw = readFileSync(cacheFile, "utf8");
		const parsed = JSON.parse(raw) as ModelsCache;
		if (!Array.isArray(parsed.models)) return null;
		if (!Number.isFinite(parsed.fetchedAt)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function readClientVersionCache(): { version: string; fetchedAt: number } | null {
	try {
		if (!existsSync(CLIENT_VERSION_CACHE_FILE)) return null;
		const raw = readFileSync(CLIENT_VERSION_CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as { version?: string; fetchedAt?: number };
		if (!parsed.version || typeof parsed.fetchedAt !== "number") return null;
		return { version: parsed.version, fetchedAt: parsed.fetchedAt };
	} catch {
		return null;
	}
}

function writeClientVersionCache(version: string): void {
	try {
		mkdirSync(dirname(CLIENT_VERSION_CACHE_FILE), { recursive: true });
		const payload = JSON.stringify(
			{ version, fetchedAt: Date.now() },
			null,
			2,
		);
		const tempName = `${CLIENT_VERSION_CACHE_FILE}.tmp.${randomBytes(8).toString("hex")}`;
		writeFileSync(tempName, payload, "utf8");
		renameSync(tempName, CLIENT_VERSION_CACHE_FILE);
	} catch {
		// ignore
	}
}

function readInMemoryModelsCache(accountId?: string): ModelsCache | null {
	return inMemoryModelsCacheByAccount.get(accountId ?? null) ?? null;
}

function writeInMemoryModelsCache(cache: ModelsCache, accountId?: string): void {
	inMemoryModelsCacheByAccount.set(accountId ?? null, cache);
}

function readSessionModelsCache(accountId?: string): ModelsCache | null {
	const cached = readInMemoryModelsCache(accountId);
	if (cached) {
		// Apply hard session limit (Issue 8)
		if (Date.now() - cached.fetchedAt > MODELS_SESSION_MAX_AGE_MS) {
			inMemoryModelsCacheByAccount.delete(accountId ?? null);
			return readModelsCache(accountId);
		}
		return cached;
	}
	const disk = readModelsCache(accountId);
	if (disk) writeInMemoryModelsCache(disk, accountId);
	return disk;
}

function extractVariantEfforts(models: ModelInfo[]): Map<string, string[]> {
	const efforts = new Map<string, string[]>();
	for (const model of models) {
		if (!model?.slug) continue;
		const levels = model.supported_reasoning_levels ?? [];
		const normalized = levels
			.map((level) => level?.effort)
			.filter((effort): effort is string => typeof effort === "string")
			.map((effort) => effort.trim().toLowerCase())
			.filter((effort) => SUPPORTED_EFFORTS.has(effort));
		if (normalized.length === 0) continue;
		const baseId = normalizeModelSlug(model.slug);
		efforts.set(baseId, Array.from(new Set(normalized)));
	}
	return efforts;
}

export function getCachedVariantEfforts(): Map<string, string[]> {
	const cached = readSessionModelsCache();
	if (!cached?.models) return new Map();
	return extractVariantEfforts(cached.models);
}

function isCacheFresh(cache: ModelsCache | null): boolean {
	if (!cache) return false;
	if (!Number.isFinite(cache.fetchedAt)) return false;
	return Date.now() - cache.fetchedAt < MODELS_CACHE_TTL_MS;
}

async function writeModelsCache(cache: ModelsCache, accountId?: string): Promise<void> {
	const cacheFile = getModelsCacheFile(accountId);
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
		let release: (() => Promise<void>) | null = null;
		try {
			release = await lockfile.lock(CACHE_DIR, LOCK_OPTIONS);
			const tmpPath = `${cacheFile}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
				renameSync(tmpPath, cacheFile);
			} catch (error) {
				try {
					unlinkSync(tmpPath);
				} catch {
					// ignore cleanup failures
				}
				throw error;
			}
		} finally {
			if (release) {
				await release().catch(() => undefined);
			}
		}
	} catch (error) {
		logWarn("Failed to write models cache", error);
	}
}

function parseModelsResponse(payload: unknown): ModelInfo[] {
	if (!payload || typeof payload !== "object") return [];
	const maybeModels = (payload as { models?: unknown }).models;
	if (!Array.isArray(maybeModels)) return [];
	return maybeModels.filter(
		(entry): entry is ModelInfo =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { slug?: unknown }).slug === "string",
	);
}

function buildModelsHeaders(
	accessToken?: string,
	accountId?: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		[OPENAI_HEADERS.BETA]: OPENAI_HEADER_VALUES.BETA_RESPONSES,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
	};
	if (accessToken) {
		headers.Authorization = `Bearer ${accessToken}`;
	}
	if (accountId) {
		headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	}
	return headers;
}

async function fetchModelsFromServer(
	options: ModelsFetchOptions,
	cachedEtag?: string | null,
): Promise<{ models: ModelInfo[]; etag: string | null; notModified?: boolean } | null> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

	try {
		const baseUrl = `${CODEX_BASE_URL}${URL_PATHS.CODEX_MODELS}`;
		const clientVersion = await resolveCodexClientVersion(fetchImpl);
		const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}client_version=${encodeURIComponent(clientVersion)}`;
		const headers = buildModelsHeaders(options.accessToken, options.accountId);
		if (cachedEtag) headers["If-None-Match"] = cachedEtag;
		const response = await fetchImpl(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (response.status === 304) {
			return {
				models: [],
				etag: response.headers.get("etag") ?? cachedEtag ?? null,
				notModified: true,
			};
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const parsed = parseModelsResponse(await response.json());
		if (parsed.length === 0) {
			throw new Error("Models payload missing models array");
		}
		const responseEtag = response.headers.get("etag");
		return { models: parsed, etag: responseEtag };
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchModelsFromGitHub(
	options: ModelsFetchOptions,
): Promise<ModelInfo[] | null> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const refs: string[] = [];
	try {
		const latestTag = await getLatestReleaseTag(fetchImpl);
		refs.push(latestTag);
	} catch (error) {
		logDebug("Failed to determine latest codex release tag; trying main fallback", error);
	}
	refs.push("main");

	for (const ref of refs) {
		const url = `https://raw.githubusercontent.com/openai/codex/${ref}/codex-rs/core/models.json`;
		try {
			const response = await fetchImpl(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const parsed = parseModelsResponse(await response.json());
			if (parsed.length > 0) {
				return parsed;
			}
		} catch (error) {
			logDebug(`Failed to fetch models.json from openai/codex@${ref}`, error);
		}
	}

	return null;
}

function resolveStaticTemplateFiles(moduleDir: string = __dirname): string[] {
	const candidateConfigDirs = [
		join(moduleDir, "..", "..", "config"),
		join(moduleDir, "..", "..", "..", "config"),
	];
	const files: string[] = [];
	const seen = new Set<string>();

	for (const configDir of candidateConfigDirs) {
		for (const fileName of STATIC_TEMPLATE_FILES) {
			const filePath = join(configDir, fileName);
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			files.push(filePath);
		}
	}

	return files;
}

function readStaticTemplateDefaults(moduleDir: string = __dirname): Map<string, ConfigOptions> {
	const cached = STATIC_TEMPLATE_DEFAULTS.get(moduleDir);
	if (cached) return cached;
	const defaults = new Map<string, ConfigOptions>();
	const templateFiles = resolveStaticTemplateFiles(moduleDir);

	for (const filePath of templateFiles) {
		try {
			if (!existsSync(filePath)) continue;
			const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
				provider?: { openai?: { models?: Record<string, { options?: ConfigOptions }> } };
			};
			const models = parsed.provider?.openai?.models ?? {};
			for (const [modelId, modelConfig] of Object.entries(models)) {
				const baseId = stripEffortSuffix(normalizeModelSlug(modelId));
				if (!defaults.has(baseId)) {
					defaults.set(baseId, modelConfig.options ?? {});
				}
			}
		} catch (error) {
			logWarn(`Failed to parse static template file: ${filePath}`, error);
		}
	}

	STATIC_TEMPLATE_DEFAULTS.set(moduleDir, defaults);
	return defaults;
}

async function loadServerAndCacheCatalog(
	options: ModelsFetchOptions,
): Promise<{ serverModels?: ModelInfo[]; cachedModels?: ModelInfo[] }> {
	const accountId = options.accountId;
	const cached = readSessionModelsCache(accountId);
	const cacheIsFresh = isCacheFresh(cached);
	if (cached && cacheIsFresh && !options.forceRefresh) {
		return { serverModels: cached.models, cachedModels: cached.models };
	}
	
	// Build auth key for backoff tracking (per-account or shared "auth" bucket)
	const authKey = options.accessToken
		? (options.accountId ?? "auth")
		: null;
	
	// Apply backoff guard BEFORE any server attempt (even on cold start)
	// This prevents hammering the server when it's down
	if (!options.forceRefresh && authKey) {
		const lastAttempt = lastServerAttemptByAuth.get(authKey);
		if (lastAttempt && Date.now() - lastAttempt < MODELS_SERVER_RETRY_BACKOFF_MS) {
			// Return cached if available, otherwise signal to use GitHub/static fallback
			if (cached?.models) {
				return { serverModels: cached.models, cachedModels: cached.models };
			}
			// No cache - caller should use GitHub fallback without server retry
			logDebug(`Server backoff active for ${authKey}; skipping /models fetch`);
			return { cachedModels: undefined };
		}
	}

	try {
		// Record attempt timestamp BEFORE the call (gate future calls immediately)
		if (authKey) {
			lastServerAttemptByAuth.set(authKey, Date.now());
		}
		const server = await fetchModelsFromServer(options, cached?.etag ?? null);
		if (server?.notModified && cached?.models?.length) {
			const updated = {
				...cached,
				etag: server.etag ?? cached.etag ?? null,
				fetchedAt: Date.now(),
			};
			writeInMemoryModelsCache(updated, accountId);
			await writeModelsCache(updated, accountId);
			return {
				serverModels: cached.models,
				cachedModels: cached.models,
			};
		}
		if (server) {
			const updated = {
				fetchedAt: Date.now(),
				source: "server" as const,
				models: server.models,
				etag: server.etag,
			};
			writeInMemoryModelsCache(updated, accountId);
			await writeModelsCache(updated, accountId);
			return {
				serverModels: server.models,
				cachedModels: cached?.models,
			};
		}
	} catch (error) {
		// Backoff is already set before the call, so future calls will be gated
		logDebug("Server /models fetch failed; attempting fallbacks", error);
	}

	return { cachedModels: cached?.models };
}

function resolveModelInfo(
	models: ModelInfo[],
	normalizedModel: string,
): ModelInfo | undefined {
	const target = normalizeModelSlug(normalizedModel);
	const bySlug = new Map(models.map((model) => [normalizeModelSlug(model.slug), model]));
	return bySlug.get(target) ?? bySlug.get(stripEffortSuffix(target));
}

export async function getCodexModelRuntimeDefaults(
	normalizedModel: string,
	options: ModelsFetchOptions = {},
): Promise<CodexModelRuntimeDefaults> {
	const accountId = options.accountId;
	const { serverModels, cachedModels } = await loadServerAndCacheCatalog(options);
	let model = resolveModelInfo(serverModels ?? [], normalizedModel);

	if (!model && cachedModels) {
		model = resolveModelInfo(cachedModels, normalizedModel);
	}

	if (!model) {
		try {
			const githubModels = await fetchModelsFromGitHub(options);
			if (githubModels) {
				const updated: ModelsCache = {
					fetchedAt: Date.now(),
					source: "github",
					models: githubModels,
					etag: null,
				};
				writeInMemoryModelsCache(updated, accountId);
				await writeModelsCache(updated, accountId);
				model = resolveModelInfo(githubModels, normalizedModel);
			}
		} catch (error) {
			logDebug("GitHub models fallback failed; using static template defaults", error);
		}
	}

	const staticDefaults = readStaticTemplateDefaults();
	const staticDefaultPersonality =
		(staticDefaults.get(stripEffortSuffix(normalizeModelSlug(normalizedModel)))
			?.personality as PersonalityOption | undefined) ?? STATIC_DEFAULT_PERSONALITY;

	const instructionsVariables = model?.model_messages?.instructions_variables;
	const instructionsTemplate = model?.model_messages?.instructions_template ?? undefined;
	const explicitOnlineDefault = normalizePersonalityValue(
		instructionsVariables?.personality,
	);
	const personalityMessages = extractPersonalityMessages(instructionsVariables);
	const supportedReasoningEfforts = (model?.supported_reasoning_levels ?? [])
		.map((level) => level?.effort)
		.filter((effort): effort is string => typeof effort === "string")
		.map((effort) => effort.trim().toLowerCase())
		.filter((effort) => SUPPORTED_EFFORTS.has(effort));
	const defaultReasoningEffort =
		typeof model?.default_reasoning_level === "string"
			? model.default_reasoning_level.trim().toLowerCase()
			: undefined;
	const defaultVerbosity =
		typeof model?.default_verbosity === "string"
			? model.default_verbosity.trim().toLowerCase()
			: undefined;

	return {
		onlineDefaultPersonality: explicitOnlineDefault,
		instructionsTemplate: instructionsTemplate ?? undefined,
		baseInstructions:
			typeof model?.base_instructions === "string" ? model.base_instructions : undefined,
		applyPatchToolType:
			typeof model?.apply_patch_tool_type === "string" ? model.apply_patch_tool_type : undefined,
		personalityMessages,
		staticDefaultPersonality,
		defaultReasoningEffort,
		supportedReasoningEfforts:
			supportedReasoningEfforts.length > 0 ? supportedReasoningEfforts : undefined,
		supportsReasoningSummaries:
			typeof model?.supports_reasoning_summaries === "boolean"
				? model.supports_reasoning_summaries
				: undefined,
		reasoningSummaryFormat:
			typeof model?.reasoning_summary_format === "string"
				? model.reasoning_summary_format
				: undefined,
		supportsVerbosity:
			typeof model?.support_verbosity === "boolean"
				? model.support_verbosity
				: undefined,
		defaultVerbosity,
	};
}

export async function warmCodexModelCatalog(
	options: ModelsFetchOptions = {},
): Promise<void> {
	const accountId = options.accountId;
	try {
		if (readInMemoryModelsCache(accountId)) return;
		const cached = readModelsCache(accountId);
		if (!cached) return;
		writeInMemoryModelsCache(cached, accountId);
		if (isCacheFresh(cached)) return;
		if (!options.fetchImpl && !options.accessToken && !options.accountId) return;
		await loadServerAndCacheCatalog(options);
	} catch {
		// Warm failures should not block startup.
	}
}

export const __internal = {
	MODELS_CACHE_FILE_BASE,
	getModelsCacheFile,
	CLIENT_VERSION_CACHE_FILE,
	readStaticTemplateDefaults,
	resolveStaticTemplateFiles,
	readModelsCache,
};
