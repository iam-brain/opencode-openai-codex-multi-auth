import { logDebug, logWarn } from "../logger.js";
import type { CodexModelRuntimeDefaults } from "../prompts/codex-models.js";
import { getNormalizedModel } from "./helpers/model-map.js";
import { normalizeOrphanedToolOutputs } from "./helpers/input-utils.js";
import type {
	ConfigOptions,
	InputItem,
	ReasoningConfig,
	RequestBody,
	UserConfig,
} from "../types.js";

type PersonalityOption = NonNullable<ConfigOptions["personality"]>;

const PERSONALITY_VALUES = new Set<PersonalityOption>([
	"none",
	"friendly",
	"pragmatic",
]);
const PERSONALITY_PLACEHOLDER = "{{ personality }}";
const PERSONALITY_FALLBACK_TEXT: Record<Exclude<PersonalityOption, "none">, string> = {
	friendly:
		"Adopt a friendly, collaborative tone while staying technically precise.",
	pragmatic:
		"Adopt a pragmatic, concise, execution-focused tone with direct guidance.",
};
let didLogInvalidPersonality = false;

type PersonalityParseResult =
	| { kind: "unset" }
	| { kind: "valid"; value: PersonalityOption }
	| { kind: "invalid" };

function parsePersonalityValue(
	value: unknown,
	source: "model" | "global",
): PersonalityParseResult {
	if (typeof value !== "string") return { kind: "unset" };
	const normalized = value.trim().toLowerCase();
	if (!normalized) return { kind: "unset" };
	if (!PERSONALITY_VALUES.has(normalized as PersonalityOption)) {
		if (!didLogInvalidPersonality) {
			logDebug(
				`Invalid ${source} personality "${value}" detected; coercing to "none"`,
			);
			didLogInvalidPersonality = true;
		}
		return { kind: "invalid" };
	}
	return { kind: "valid", value: normalized as PersonalityOption };
}

function resolvePersonality(
	modelOptions: ConfigOptions,
	globalOptions: ConfigOptions,
	runtimeDefaults?: CodexModelRuntimeDefaults,
): PersonalityOption {
	const modelValue = parsePersonalityValue(modelOptions.personality, "model");
	if (modelValue.kind === "valid") return modelValue.value;
	if (modelValue.kind === "invalid") return "none";

	// Online model default is preferred over global backup when available.
	if (runtimeDefaults?.onlineDefaultPersonality) {
		return runtimeDefaults.onlineDefaultPersonality;
	}

	const globalValue = parsePersonalityValue(
		globalOptions.personality,
		"global",
	);
	if (globalValue.kind === "valid") return globalValue.value;
	if (globalValue.kind === "invalid") return "none";

	return runtimeDefaults?.staticDefaultPersonality ?? "none";
}

function getModelLookupCandidates(
	originalModel: string | undefined,
	normalizedModel: string,
): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const add = (value: string | undefined) => {
		if (!value) return;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		candidates.push(trimmed);
	};

	add(originalModel);
	add(originalModel?.split("/").pop());
	add(normalizedModel);
	add(normalizedModel.split("/").pop());

	return candidates;
}

function resolvePersonalityMessage(
	personality: PersonalityOption,
	runtimeDefaults?: CodexModelRuntimeDefaults,
): string {
	if (personality === "none") {
		return runtimeDefaults?.personalityMessages?.default ?? "";
	}
	return (
		runtimeDefaults?.personalityMessages?.[personality] ??
		PERSONALITY_FALLBACK_TEXT[personality]
	);
}

function renderCodexInstructions(
	baseInstructions: string,
	personality: PersonalityOption,
	runtimeDefaults?: CodexModelRuntimeDefaults,
): string {
	const instructions = runtimeDefaults?.instructionsTemplate ?? baseInstructions;
	const personalityMessage = resolvePersonalityMessage(personality, runtimeDefaults);

	if (instructions.includes(PERSONALITY_PLACEHOLDER)) {
		return instructions.replaceAll(PERSONALITY_PLACEHOLDER, personalityMessage);
	}

	if (personality === "none") return instructions;

	const appended = personalityMessage.trim();
	if (!appended) return instructions;

	return `${instructions}\n\n<personality_spec>\n${appended}\n</personality_spec>`;
}

/**
 * Normalize model name to Codex-supported variants
 *
 * Uses explicit model map for known models, with fallback pattern matching
 * for unknown/custom model names.
 *
 * @param model - Original model name (e.g., "gpt-5.1-codex-low", "openai/gpt-5-codex")
 * @returns Normalized model name (e.g., "gpt-5.1-codex", "gpt-5-codex")
 */
export function normalizeModel(model: string | undefined): string {
	if (!model) return "gpt-5.1";

	// Strip provider prefix if present (e.g., "openai/gpt-5-codex" → "gpt-5-codex")
	const modelId = model.includes("/") ? model.split("/").pop()! : model;

	// Try explicit model map first (handles all known model variants)
	const mappedModel = getNormalizedModel(modelId);
	if (mappedModel) {
		return mappedModel;
	}

	// Fallback: Pattern-based matching for unknown/custom model names
	// This preserves backwards compatibility with old verbose names
	// like "GPT 5 Codex Low (ChatGPT Subscription)"
	const normalized = modelId.toLowerCase();

	// Priority order for pattern matching (most specific first):
	// 1. GPT-5.2 Codex (newest codex model)
	if (
		normalized.includes("gpt-5.2-codex") ||
		normalized.includes("gpt 5.2 codex")
	) {
		return "gpt-5.2-codex";
	}

	// 2. GPT-5.2 (general purpose)
	if (normalized.includes("gpt-5.2") || normalized.includes("gpt 5.2")) {
		return "gpt-5.2";
	}

	// 3. GPT-5.1 Codex Max
	if (
		normalized.includes("gpt-5.1-codex-max") ||
		normalized.includes("gpt 5.1 codex max")
	) {
		return "gpt-5.1-codex-max";
	}

	// 4. GPT-5.1 Codex Mini
	if (
		normalized.includes("gpt-5.1-codex-mini") ||
		normalized.includes("gpt 5.1 codex mini")
	) {
		return "gpt-5.1-codex-mini";
	}

	// 5. Legacy Codex Mini
	if (
		normalized.includes("codex-mini-latest") ||
		normalized.includes("gpt-5-codex-mini") ||
		normalized.includes("gpt 5 codex mini")
	) {
		return "codex-mini-latest";
	}

	// 6. GPT-5.1 Codex
	if (
		normalized.includes("gpt-5.1-codex") ||
		normalized.includes("gpt 5.1 codex")
	) {
		return "gpt-5.1-codex";
	}

	// 7. GPT-5.1 (general-purpose)
	if (normalized.includes("gpt-5.1") || normalized.includes("gpt 5.1")) {
		return "gpt-5.1";
	}

	// 8. GPT-5 Codex family (any variant with "codex")
	if (normalized.includes("codex")) {
		return "gpt-5.1-codex";
	}

	// 9. GPT-5 family (any variant) - default to 5.1 as 5 is being phased out
	if (normalized.includes("gpt-5") || normalized.includes("gpt 5")) {
		return "gpt-5.1";
	}

	// Default fallback - use gpt-5.1 as gpt-5 is being phased out
	return "gpt-5.1";
}

/**
 * Extract configuration for a specific model
 * Merges global options with model-specific options (model-specific takes precedence)
 * @param modelName - Model name (e.g., "gpt-5-codex")
 * @param userConfig - Full user configuration object
 * @returns Merged configuration for this model
 */
export function getModelConfig(
	modelName: string,
	userConfig: UserConfig = { global: {}, models: {} },
): ConfigOptions {
	const globalOptions = userConfig.global || {};
	const modelOptions = userConfig.models?.[modelName]?.options || {};

	return { ...globalOptions, ...modelOptions };
}

function resolveReasoningConfig(
	modelName: string,
	modelConfig: ConfigOptions,
	body: RequestBody,
): ReasoningConfig {
	const providerOpenAI = body.providerOptions?.openai;
	const existingEffort =
		body.reasoning?.effort ?? providerOpenAI?.reasoningEffort;
	const existingSummary =
		body.reasoning?.summary ?? providerOpenAI?.reasoningSummary;

	const mergedConfig: ConfigOptions = {
		...modelConfig,
		...(existingEffort ? { reasoningEffort: existingEffort } : {}),
		...(existingSummary ? { reasoningSummary: existingSummary } : {}),
	};

	return getReasoningConfig(modelName, mergedConfig);
}

function resolveTextVerbosity(
	modelConfig: ConfigOptions,
	body: RequestBody,
): "low" | "medium" | "high" {
	const providerOpenAI = body.providerOptions?.openai;
	return (
		body.text?.verbosity ??
		providerOpenAI?.textVerbosity ??
		modelConfig.textVerbosity ??
		"medium"
	);
}

function resolveInclude(modelConfig: ConfigOptions, body: RequestBody): string[] {
	const providerOpenAI = body.providerOptions?.openai;
	const base =
		body.include ??
		providerOpenAI?.include ??
		modelConfig.include ??
		["reasoning.encrypted_content"];
	const include = Array.from(new Set(base.filter(Boolean)));
	if (!include.includes("reasoning.encrypted_content")) {
		include.push("reasoning.encrypted_content");
	}
	return include;
}

/**
 * Configure reasoning parameters based on model variant and user config
 *
 * NOTE: This plugin follows Codex CLI defaults instead of opencode defaults because:
 * - We're accessing the ChatGPT backend API (not OpenAI Platform API)
 * - opencode explicitly excludes gpt-5-codex from automatic reasoning configuration
 * - Codex CLI has been thoroughly tested against this backend
 *
 * @param originalModel - Original model name before normalization
 * @param userConfig - User configuration object
 * @returns Reasoning configuration
 */
export function getReasoningConfig(
	modelName: string | undefined,
	userConfig: ConfigOptions = {},
): ReasoningConfig {
	const normalizedName = modelName?.toLowerCase() ?? "";

	// GPT-5.2 Codex is the newest codex model (supports xhigh, but not "none")
	const isGpt52Codex =
		normalizedName.includes("gpt-5.2-codex") ||
		normalizedName.includes("gpt 5.2 codex");

	// GPT-5.2 general purpose (not codex variant)
	const isGpt52General =
		(normalizedName.includes("gpt-5.2") || normalizedName.includes("gpt 5.2")) &&
		!isGpt52Codex;
	const isCodexMax =
		normalizedName.includes("codex-max") ||
		normalizedName.includes("codex max");
	const isCodexMini =
		normalizedName.includes("codex-mini") ||
		normalizedName.includes("codex mini") ||
		normalizedName.includes("codex_mini") ||
		normalizedName.includes("codex-mini-latest");
	const isCodex = normalizedName.includes("codex") && !isCodexMini;
	const isLightweight =
		!isCodexMini &&
		(normalizedName.includes("nano") ||
			normalizedName.includes("mini"));

	// GPT-5.1 general purpose (not codex variants) - supports "none" per OpenAI API docs
	const isGpt51General =
		(normalizedName.includes("gpt-5.1") || normalizedName.includes("gpt 5.1")) &&
		!isCodex &&
		!isCodexMax &&
		!isCodexMini;

	// GPT 5.2, GPT 5.2 Codex, and Codex Max support xhigh reasoning
	const supportsXhigh = isGpt52General || isGpt52Codex || isCodexMax;

	// GPT 5.1 general and GPT 5.2 general support "none" reasoning per:
	// - OpenAI API docs: "gpt-5.1 defaults to none, supports: none, low, medium, high"
	// - Codex CLI: ReasoningEffort enum includes None variant (codex-rs/protocol/src/openai_models.rs)
	// - Codex CLI: docs/config.md lists "none" as valid for model_reasoning_effort
	// - gpt-5.2 (being newer) also supports: none, low, medium, high, xhigh
	// - Codex models (including GPT-5.2 Codex) do NOT support "none"
	const supportsNone = isGpt52General || isGpt51General;

	// Default based on model type (Codex CLI defaults)
	// Note: OpenAI docs say gpt-5.1 defaults to "none", but we default to "medium"
	// for better coding assistance unless user explicitly requests "none"
	const defaultEffort: ReasoningConfig["effort"] = isCodexMini
		? "medium"
		: supportsXhigh
			? "high"
			: isLightweight
				? "minimal"
				: "medium";

	let effort = userConfig.reasoningEffort || defaultEffort;

	if (isCodexMini) {
		if (effort === "minimal" || effort === "low" || effort === "none") {
			effort = "medium";
		}
		if (effort === "xhigh") {
			effort = "high";
		}
		if (effort !== "high" && effort !== "medium") {
			effort = "medium";
		}
	}

	if (!supportsXhigh && effort === "xhigh") {
		effort = "high";
	}

	// For models that don't support "none", upgrade to "low"
	// (Codex models don't support "none" - only GPT-5.1 and GPT-5.2 general purpose do)
	if (!supportsNone && effort === "none") {
		effort = "low";
	}

	// Normalize "minimal" to "low" for all non-mini models
	// The ChatGPT Codex backend does not accept "minimal" (supports none/low/medium/high).
	if (effort === "minimal") {
		effort = "low";
	}

	return {
		effort,
		summary: userConfig.reasoningSummary || "auto", // Changed from "detailed" to match Codex CLI
	};
}

/**
 * Filter input array for stateless Codex API (store: false)
 *
 * Two transformations needed:
 * 1. Remove AI SDK-specific items (not supported by Codex API)
 * 2. Strip IDs from all remaining items (stateless mode)
 *
 * AI SDK constructs to REMOVE (not in OpenAI Responses API spec):
 * - type: "item_reference" - AI SDK uses this for server-side state lookup
 *
 * Items to KEEP (strip IDs):
 * - type: "message" - Conversation messages (provides context to LLM)
 * - type: "function_call" - Tool calls from conversation
 * - type: "function_call_output" - Tool results from conversation
 *
 * Context is maintained through:
 * - Full message history (without IDs)
 * - reasoning.encrypted_content (for reasoning continuity)
 *
 * @param input - Original input array from OpenCode/AI SDK
 * @returns Filtered input array compatible with Codex API
 */
export function filterInput(
	input: InputItem[] | undefined,
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter((item) => {
			if (item.type === "item_reference") {
				return false;
			}
			return true;
		})
		.map((item) => {
			// Strip IDs from all items (Codex API stateless mode)
			if (item.id) {
				const { id, ...itemWithoutId } = item;
				return itemWithoutId as InputItem;
			}
			return item;
		});
}

/**
 * Transform request body for Codex API
 *
 * NOTE: Configuration follows Codex CLI patterns instead of opencode defaults:
 * - opencode sets textVerbosity="low" for gpt-5, but Codex CLI uses "medium"
 * - opencode excludes gpt-5-codex from reasoning configuration
 * - This plugin uses store=false (stateless), requiring encrypted reasoning content
 *
 * @param body - Original request body
 * @param codexInstructions - Codex system instructions
 * @param userConfig - User configuration from loader
 * @param runtimeDefaults - Runtime model defaults resolved from server/cache/static fallback
 * @returns Transformed request body
 */
export async function transformRequestBody(
	body: RequestBody,
	codexInstructions: string,
	userConfig: UserConfig = { global: {}, models: {} },
	runtimeDefaults?: CodexModelRuntimeDefaults,
): Promise<RequestBody> {
	const originalModel = body.model;
	const normalizedModel = normalizeModel(body.model);
	const globalOptions = userConfig.global || {};
	const lookupCandidates = getModelLookupCandidates(originalModel, normalizedModel);
	const resolvedModelKey = lookupCandidates.find(
		(candidate) => !!userConfig.models?.[candidate],
	);
	const modelLookupKey = resolvedModelKey ?? normalizedModel;
	const modelOptions = userConfig.models?.[modelLookupKey]?.options || {};

	// Get model-specific configuration using ORIGINAL model name (config key)
	// with fallbacks for provider-prefixed and normalized aliases
	const modelConfig = getModelConfig(modelLookupKey, userConfig);
	const personality = resolvePersonality(
		modelOptions,
		globalOptions,
		runtimeDefaults,
	);

	logDebug(
		`Model config lookup: "${modelLookupKey}" → normalized to "${normalizedModel}" for API`,
		{
			lookupCandidates,
			hasModelSpecificConfig: !!resolvedModelKey,
			resolvedConfig: modelConfig,
			personality,
		},
	);

	// Normalize model name for API call
	body.model = normalizedModel;

	body.store = false;
	body.stream = true;
	body.instructions = renderCodexInstructions(
		codexInstructions,
		personality,
		runtimeDefaults,
	);

	// Prompt caching relies on the host providing a stable prompt_cache_key
	// (OpenCode passes its session identifier). We no longer synthesize one here.

	// Filter and transform input
	if (body.input && Array.isArray(body.input)) {
		const originalIds = body.input
			.filter((item) => item.id)
			.map((item) => item.id);
		if (originalIds.length > 0) {
			logDebug(
				`Filtering ${originalIds.length} message IDs from input:`,
				originalIds,
			);
		}

		body.input = filterInput(body.input);

		const remainingIds = (body.input || [])
			.filter((item) => item.id)
			.map((item) => item.id);
		if (remainingIds.length > 0) {
			logWarn(
				`WARNING: ${remainingIds.length} IDs still present after filtering:`,
				remainingIds,
			);
		} else if (originalIds.length > 0) {
			logDebug(`Successfully removed all ${originalIds.length} message IDs`);
		}

		// Handle orphaned function_call_output items (where function_call was an item_reference that got filtered)
		// Instead of removing orphans (which causes infinite loops as LLM loses tool results),
		// convert them to messages to preserve context while avoiding API errors
		if (body.input) {
			body.input = normalizeOrphanedToolOutputs(body.input);
		}
	}

	const reasoningConfig = resolveReasoningConfig(
		normalizedModel,
		modelConfig,
		body,
	);
	body.reasoning = {
		...body.reasoning,
		...reasoningConfig,
	};

	body.text = {
		...body.text,
		verbosity: resolveTextVerbosity(modelConfig, body),
	};

	body.include = resolveInclude(modelConfig, body);

	body.max_output_tokens = undefined;
	body.max_completion_tokens = undefined;

	return body;
}
