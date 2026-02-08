import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOpencodeCacheDir } from "./paths.js";
import { logWarn } from "./logger.js";

type ModelConfig = Record<string, unknown> & {
	name?: string;
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[]; output?: string[] };
	description?: string;
	visibility?: string;
	priority?: number;
	supportedInApi?: boolean;
	minimalClientVersion?: string;
};

type ModelsCache = {
	models?: Array<CatalogModel>;
};

type CatalogModel = {
	slug?: string;
	display_name?: string;
	description?: string;
	visibility?: string;
	priority?: number;
	supported_in_api?: boolean;
	minimal_client_version?: string;
	context_window?: number;
	truncation_policy?: { mode?: string; limit?: number };
	input_modalities?: string[];
	output_modalities?: string[];
};

const EFFORT_SUFFIX_REGEX = /-(none|minimal|low|medium|high|xhigh)$/i;
const STATIC_TEMPLATE_FILES = ["opencode-modern.json", "opencode-legacy.json"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseId(modelId: string): string {
	return modelId.toLowerCase().trim().replace(EFFORT_SUFFIX_REGEX, "");
}

function resolveStaticTemplateFiles(moduleDir: string = __dirname): string[] {
	const candidateDirs = [
		join(moduleDir, "..", "config"),
		join(moduleDir, "..", "..", "config"),
		join(moduleDir, "..", "..", "..", "config"),
	];
	const files: string[] = [];
	const seen = new Set<string>();

	for (const configDir of candidateDirs) {
		for (const fileName of STATIC_TEMPLATE_FILES) {
			const filePath = join(configDir, fileName);
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			files.push(filePath);
		}
	}

	return files;
}

function readStaticTemplateModels(moduleDir: string = __dirname): Map<string, ModelConfig> {
	const models = new Map<string, ModelConfig>();
	const templateFiles = resolveStaticTemplateFiles(moduleDir);

	for (const filePath of templateFiles) {
		try {
			if (!existsSync(filePath)) continue;
			const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
				provider?: { openai?: { models?: Record<string, ModelConfig> } };
			};
			const templateModels = parsed.provider?.openai?.models ?? {};
			for (const [modelId, config] of Object.entries(templateModels)) {
				if (!isObjectRecord(config)) continue;
				const baseId = normalizeBaseId(modelId);
				if (models.has(baseId)) continue;
				models.set(baseId, JSON.parse(JSON.stringify(config)) as ModelConfig);
			}
		} catch (error) {
			logWarn(`Failed to parse static template file: ${filePath}`, error);
		}
	}

	return models;
}

function readCachedCatalogSlugs(cacheFile: string): string[] {
	try {
		if (!existsSync(cacheFile)) return [];
		const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as ModelsCache;
		const slugs = parsed.models?.map((model) => model.slug).filter(Boolean) ?? [];
		return Array.from(
			new Set(slugs.map((slug) => normalizeBaseId(slug as string))),
		);
	} catch (error) {
		logWarn("Failed to read codex model cache", error);
		return [];
	}
}

function readCachedCatalogModels(cacheFile: string): CatalogModel[] {
	try {
		if (!existsSync(cacheFile)) return [];
		const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as ModelsCache;
		return parsed.models?.filter((model) => model?.slug) ?? [];
	} catch (error) {
		logWarn("Failed to read codex model cache", error);
		return [];
	}
}

/**
 * Find the appropriate template ID for a model slug.
 * 
 * Rules:
 * - Codex models (contain "-codex") → fall back to codex templates
 * - Non-codex GPT models → fall back to non-codex templates
 * - Never mix: don't apply codex defaults to non-codex models
 */
function pickTemplateId(baseId: string, defaults: Map<string, ModelConfig>): string | null {
	// Direct match first
	if (defaults.has(baseId)) return baseId;
	
	const isCodexModel = baseId.includes("-codex");
	
	if (isCodexModel) {
		// Codex model fallbacks (most specific to least specific)
		if (baseId.includes("-codex-max") && defaults.has("gpt-5.1-codex-max")) {
			return "gpt-5.1-codex-max";
		}
		if (baseId.includes("-codex-mini") && defaults.has("gpt-5.1-codex-mini")) {
			return "gpt-5.1-codex-mini";
		}
		// Generic codex fallback - newest available
		if (defaults.has("gpt-5.3-codex")) return "gpt-5.3-codex";
		if (defaults.has("gpt-5.2-codex")) return "gpt-5.2-codex";
		if (defaults.has("gpt-5.1-codex")) return "gpt-5.1-codex";
	} else if (baseId.startsWith("gpt-5.")) {
		// Non-codex GPT model fallbacks (e.g., gpt-5.2-pro, gpt-5.3)
		if (defaults.has("gpt-5.2")) return "gpt-5.2";
		if (defaults.has("gpt-5.1")) return "gpt-5.1";
	}
	
	return null;
}

function formatModelDisplayName(baseId: string): string {
	const parts = baseId.split("-").filter(Boolean);
	if (parts.length === 0) return `${baseId} (Codex)`;
	let label = "";
	if (parts[0] === "gpt" && parts[1]) {
		label = `GPT ${parts[1]}`;
		for (const part of parts.slice(2)) {
			label += ` ${part.charAt(0).toUpperCase()}${part.slice(1)}`;
		}
	} else {
		label = parts
			.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
			.join(" ");
	}
	return `${label} (Codex)`;
}

function applyCatalogMetadata(
	config: ModelConfig,
	model: CatalogModel,
): ModelConfig {
	const next: ModelConfig = { ...config };
	if (typeof model.display_name === "string" && model.display_name.trim()) {
		next.name = model.display_name.trim();
	}
	if (Number.isFinite(model.context_window)) {
		next.limit = {
			...next.limit,
			context: model.context_window,
		};
	}
	const truncationLimit = model.truncation_policy?.limit;
	const truncationMode = model.truncation_policy?.mode;
	if (Number.isFinite(truncationLimit) && truncationMode === "tokens") {
		next.limit = {
			...next.limit,
			output: truncationLimit,
		};
	}
	if (Array.isArray(model.input_modalities) && model.input_modalities.length > 0) {
		next.modalities = {
			...next.modalities,
			input: [...model.input_modalities],
		};
	}
	if (Array.isArray(model.output_modalities) && model.output_modalities.length > 0) {
		next.modalities = {
			...next.modalities,
			output: [...model.output_modalities],
		};
	}
	if (typeof model.description === "string" && model.description.trim()) {
		next.description = model.description.trim();
	}
	if (typeof model.visibility === "string" && model.visibility.trim()) {
		next.visibility = model.visibility.trim();
	}
	if (typeof model.priority === "number" && Number.isFinite(model.priority)) {
		next.priority = model.priority;
	}
	if (typeof model.supported_in_api === "boolean") {
		next.supportedInApi = model.supported_in_api;
	}
	if (
		typeof model.minimal_client_version === "string" &&
		model.minimal_client_version.trim()
	) {
		next.minimalClientVersion = model.minimal_client_version.trim();
	}
	return next;
}

export function buildInternalModelDefaults(options?: {
	cacheFile?: string;
	moduleDir?: string;
}): Record<string, ModelConfig> {
	const moduleDir = options?.moduleDir ?? __dirname;
	const defaults = readStaticTemplateModels(moduleDir);
	const cacheFile = options?.cacheFile ?? join(getOpencodeCacheDir(), "codex-models-cache.json");
	const catalogModels = readCachedCatalogModels(cacheFile);
	const catalogSlugs = readCachedCatalogSlugs(cacheFile);

	for (const slug of catalogSlugs) {
		if (!defaults.has(slug)) {
			const templateId = pickTemplateId(slug, defaults);
			if (!templateId) continue;
			const template = defaults.get(templateId);
			if (!template) continue;
			const cloned = JSON.parse(JSON.stringify(template)) as ModelConfig;
			cloned.name = formatModelDisplayName(slug);
			defaults.set(slug, cloned);
		}
	}

	for (const model of catalogModels) {
		const slug = model.slug ? normalizeBaseId(model.slug) : undefined;
		if (!slug) continue;
		const existing = defaults.get(slug);
		if (!existing) continue;
		const updated = applyCatalogMetadata(existing, model);
		if (!updated.name) {
			updated.name = formatModelDisplayName(slug);
		}
		defaults.set(slug, updated);
	}

	return Object.fromEntries(defaults);
}

export function mergeModelDefaults(
	userModels: unknown,
	defaults: Record<string, ModelConfig>,
): Record<string, ModelConfig> {
	const merged: Record<string, ModelConfig> = { ...defaults };
	if (!isObjectRecord(userModels)) return merged;
	for (const [modelId, override] of Object.entries(userModels)) {
		const base = isObjectRecord(merged[modelId]) ? merged[modelId] : {};
		if (!isObjectRecord(override)) {
			merged[modelId] = override as ModelConfig;
			continue;
		}
		const next: ModelConfig = { ...base, ...override };
		if (isObjectRecord(base.limit) || isObjectRecord(override.limit)) {
			next.limit = {
				...(base.limit as Record<string, unknown> | undefined),
				...(override.limit as Record<string, unknown> | undefined),
			} as ModelConfig["limit"];
		}
		if (isObjectRecord(base.options) || isObjectRecord(override.options)) {
			next.options = {
				...(base.options as Record<string, unknown> | undefined),
				...(override.options as Record<string, unknown> | undefined),
			};
		}
		if (isObjectRecord(base.variants) || isObjectRecord(override.variants)) {
			next.variants = {
				...(base.variants as Record<string, unknown> | undefined),
				...(override.variants as Record<string, unknown> | undefined),
			};
		}
		merged[modelId] = next;
	}
	return merged;
}

export const __internal = {
	readStaticTemplateModels,
	resolveStaticTemplateFiles,
};
