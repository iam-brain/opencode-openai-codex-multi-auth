import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
}

interface ModelMessages {
	instructions_template?: string | null;
	instructions_variables?: ModelInstructionsVariables | null;
}

interface ModelInfo {
	slug: string;
	model_messages?: ModelMessages | null;
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
	personalityMessages?: {
		default?: string;
		friendly?: string;
		pragmatic?: string;
	};
	instructionsTemplate?: string;
	staticDefaultPersonality: PersonalityOption;
}

export interface ModelsFetchOptions {
	accessToken?: string;
	accountId?: string;
	forceRefresh?: boolean;
	fetchImpl?: typeof fetch;
}

const CACHE_DIR = getOpencodeCacheDir();
const MODELS_CACHE_FILE = join(CACHE_DIR, "codex-models-cache.json");
const MODELS_FETCH_TIMEOUT_MS = 5_000;
const STATIC_DEFAULT_PERSONALITY: PersonalityOption = "none";
const EFFORT_SUFFIX_REGEX = /-(none|minimal|low|medium|high|xhigh)$/i;
const PERSONALITY_VALUES = new Set<PersonalityOption>([
	"none",
	"friendly",
	"pragmatic",
]);
const STATIC_TEMPLATE_FILES = ["opencode-modern.json", "opencode-legacy.json"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function readModelsCache(): ModelsCache | null {
	try {
		if (!existsSync(MODELS_CACHE_FILE)) return null;
		const raw = readFileSync(MODELS_CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as ModelsCache;
		if (!Array.isArray(parsed.models)) return null;
		if (!Number.isFinite(parsed.fetchedAt)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function writeModelsCache(cache: ModelsCache): void {
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
		writeFileSync(MODELS_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
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
): Promise<{ models: ModelInfo[]; etag: string | null } | null> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

	try {
		const baseUrl = `${CODEX_BASE_URL}${URL_PATHS.CODEX_MODELS}`;
		const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}client_version=opencode-openai-codex-multi-auth`;
		const response = await fetchImpl(url, {
			method: "GET",
			headers: buildModelsHeaders(options.accessToken, options.accountId),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const parsed = parseModelsResponse(await response.json());
		if (parsed.length === 0) {
			throw new Error("Models payload missing models array");
		}
		const etag = response.headers.get("etag");
		return { models: parsed, etag };
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

	return defaults;
}

async function loadServerAndCacheCatalog(
	options: ModelsFetchOptions,
): Promise<{ serverModels?: ModelInfo[]; cachedModels?: ModelInfo[] }> {
	const cached = readModelsCache();

	try {
		const server = await fetchModelsFromServer(options);
		if (server) {
			writeModelsCache({
				fetchedAt: Date.now(),
				source: "server",
				models: server.models,
				etag: server.etag,
			});
			return {
				serverModels: server.models,
				cachedModels: cached?.models,
			};
		}
	} catch (error) {
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
	const { serverModels, cachedModels } = await loadServerAndCacheCatalog(options);
	let model = resolveModelInfo(serverModels ?? [], normalizedModel);

	if (!model && cachedModels) {
		model = resolveModelInfo(cachedModels, normalizedModel);
	}

	if (!model) {
		try {
			const githubModels = await fetchModelsFromGitHub(options);
			if (githubModels) {
				writeModelsCache({
					fetchedAt: Date.now(),
					source: "github",
					models: githubModels,
					etag: null,
				});
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

	return {
		onlineDefaultPersonality: explicitOnlineDefault,
		instructionsTemplate: instructionsTemplate ?? undefined,
		personalityMessages: {
			default:
				typeof instructionsVariables?.personality_default === "string"
					? instructionsVariables.personality_default
					: undefined,
			friendly:
				typeof instructionsVariables?.personality_friendly === "string"
					? instructionsVariables.personality_friendly
					: undefined,
			pragmatic:
				typeof instructionsVariables?.personality_pragmatic === "string"
					? instructionsVariables.personality_pragmatic
					: undefined,
		},
		staticDefaultPersonality,
	};
}

export const __internal = {
	MODELS_CACHE_FILE,
	readStaticTemplateDefaults,
	resolveStaticTemplateFiles,
	readModelsCache,
};
