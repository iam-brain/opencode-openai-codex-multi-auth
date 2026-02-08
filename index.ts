/**
 * OpenAI ChatGPT (Codex) OAuth Plugin
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInputForFlow,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import {
	getDefaultRetryAfterMs,
	getMaxBackoffMs,
	getPidOffsetEnabled,
	getProactiveTokenRefresh,
	getQuietMode,
	getRateLimitDedupWindowMs,
	getRateLimitStateResetMs,
	getRequestJitterMaxMs,
	getTokenRefreshSkewMs,
	loadPluginConfig,
} from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DEFAULT_MODEL_FAMILY,
	DUMMY_API_KEY,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";

import {
	AccountManager,
	extractAccountEmail,
	extractAccountId,
	extractAccountPlan,
	isOAuthAuth,
	sanitizeEmail,
} from "./lib/accounts.js";
import {
	promptRepairAccounts,
} from "./lib/cli.js";
import { normalizePlanTypeOrDefault } from "./lib/plan-utils.js";
import { configureStorageForPluginConfig } from "./lib/storage-scope.js";
import {
	getStoragePath,
	autoQuarantineCorruptAccountsFile,
	loadAccounts,
	quarantineAccounts,
	replaceAccountsFile,
	saveAccountsWithLock,
	toggleAccountEnabled,
} from "./lib/storage.js";
import { findAccountMatchIndex } from "./lib/account-matching.js";

import type { AccountStorageV3, OAuthAuthDetails, TokenResult, TokenSuccess, UserConfig } from "./lib/types.js";
import { getHealthTracker, getTokenTracker } from "./lib/rotation.js";
import { RateLimitTracker } from "./lib/rate-limit.js";
import { codexStatus } from "./lib/codex-status.js";
import { renderQuotaReport } from "./lib/ui/codex-quota-report.js";
import { runAuthMenuOnce } from "./lib/ui/auth-menu-runner.js";
import type { AccountInfo } from "./lib/ui/auth-menu.js";
import {
	ProactiveRefreshQueue,
	createRefreshScheduler,
	type RefreshScheduler,
} from "./lib/refresh-queue.js";
import { formatToastMessage } from "./lib/formatting.js";
import { logCritical } from "./lib/logger.js";
import { FetchOrchestrator } from "./lib/fetch-orchestrator.js";
import { warmCodexInstructions } from "./lib/prompts/codex.js";
import { getCachedVariantEfforts, warmCodexModelCatalog } from "./lib/prompts/codex-models.js";
import { buildInternalModelDefaults, mergeModelDefaults } from "./lib/catalog-defaults.js";

/**
 * Fallback model slugs when server is unavailable.
 * The server response is the source of truth; this is only used as a fallback.
 */
const FALLBACK_MODEL_SLUGS = new Set([
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
]);

const LEGACY_CODEX_COMMAND_KEYS = new Set([
	"codex-auth",
	"codex-status",
	"codex-switch-accounts",
	"codex-toggle-account",
	"codex-remove-account",
]);

function parseGptVersion(slug: string): { major: number; minor: number } | null {
	const match = slug.toLowerCase().match(/^gpt-(\d+)\.(\d+)/);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return { major, minor };
}

function pickLowestAvailable(available: Set<string>, pattern: RegExp): string | null {
	let best: { slug: string; major: number; minor: number } | null = null;
	for (const slug of available) {
		if (!pattern.test(slug)) continue;
		const version = parseGptVersion(slug);
		if (!version) continue;
		if (!best) {
			best = { slug, ...version };
			continue;
		}
		if (version.major < best.major) {
			best = { slug, ...version };
			continue;
		}
		if (version.major === best.major && version.minor < best.minor) {
			best = { slug, ...version };
		}
	}
	return best?.slug ?? null;
}

/**
 * Legacy model slug mappings for automatic upgrade.
 * Maps obsolete identifiers to their modern equivalents.
 * The target slugs are dynamically resolved from available models.
 */
const LEGACY_MODEL_PATTERNS: Array<{
	pattern: RegExp;
	upgrade: (available: Set<string>) => string | null;
}> = [
	// gpt-5 → lowest available gpt-5.X (dynamic)
	{
		pattern: /^gpt-5$/,
		upgrade: (available) =>
			pickLowestAvailable(available, /^gpt-5\.\d+$/i) ?? "gpt-5.1",
	},
	// gpt-5-codex → lowest available gpt-5.X-codex (dynamic)
	{
		pattern: /^gpt-5-codex$/,
		upgrade: (available) =>
			pickLowestAvailable(available, /^gpt-5\.\d+-codex$/i) ?? "gpt-5.1-codex",
	},
	// codex-mini-latest → lowest available gpt-5.X-codex-mini (dynamic)
	{
		pattern: /^codex-mini-latest$/,
		upgrade: (available) =>
			pickLowestAvailable(available, /^gpt-5\.\d+-codex-mini$/i) ??
			"gpt-5.1-codex-mini",
	},
];

/**
 * Matches official Codex model slugs with optional effort suffix.
 * Format: gpt-X.Y[-codex[-max|-mini|-pro]][-effort]
 */
const CODEX_METADATA_REGEX =
	/^(gpt-\d+\.\d+(?:-codex)?(?:-(?:max|mini|pro))?)(?:-(none|minimal|low|medium|high|xhigh))?$/i;

const CODEX_STANDARD_VARIANTS = ["low", "medium", "high"] as const;
const CODEX_XHIGH_VARIANTS = ["low", "medium", "high", "xhigh"] as const;
const CODEX_MINI_VARIANTS = ["medium", "high"] as const;

const CLONE_IDENTITY_FIELDS = [
	"id",
	"slug",
	"model",
	"name",
	"displayName",
	"display_name",
] as const;
const VARIANT_DISALLOWED_FIELDS = new Set(["id", "slug", "model", "variants"]);

function parseCodexMetadataModel(
	modelId: string,
): { baseId: string; effort?: string } | undefined {
	const match = modelId.toLowerCase().match(CODEX_METADATA_REGEX);
	if (!match?.[1]) return undefined;
	return {
		baseId: match[1],
		effort: match[2]?.toLowerCase(),
	};
}

function codexModelSupportsXhigh(baseId: string): boolean {
	const normalized = baseId.toLowerCase();
	if (normalized.includes("-codex-mini")) return false;
	if (normalized.includes("-codex-max")) return true;

	const versionPart = normalized.replace(/^gpt-/, "").split("-codex")[0];
	const [majorRaw, minorRaw = "0"] = versionPart.split(".");
	const major = Number(majorRaw);
	const minor = Number(minorRaw);

	if (!Number.isFinite(major)) return false;
	if (major > 5) return true;
	return major === 5 && Number.isFinite(minor) && minor >= 2;
}

function codexVariantSet(baseId: string): readonly string[] {
	const normalized = baseId.toLowerCase();
	if (normalized.includes("-codex-mini")) return CODEX_MINI_VARIANTS;
	if (codexModelSupportsXhigh(normalized)) return CODEX_XHIGH_VARIANTS;
	return CODEX_STANDARD_VARIANTS;
}

/**
 * Get available model slugs from the cached server response.
 * Falls back to FALLBACK_MODEL_SLUGS when cache is empty.
 */
function getAvailableModelSlugs(accountId?: string): Set<string> {
	const cached = getCachedVariantEfforts(accountId);
	if (cached.size > 0) {
		return new Set(cached.keys());
	}
	return new Set(FALLBACK_MODEL_SLUGS);
}

/**
 * Upgrade legacy model slugs to their modern equivalents.
 * Uses dynamic resolution based on available models from server.
 */
function upgradeLegacyModelSlug(modelId: string, accountId?: string): string {
	const normalized = modelId.toLowerCase().trim();
	const available = getAvailableModelSlugs(accountId);
	
	for (const { pattern, upgrade } of LEGACY_MODEL_PATTERNS) {
		if (pattern.test(normalized)) {
			const upgraded = upgrade(available);
			if (upgraded) return upgraded;
		}
	}
	
	return normalized;
}

/**
 * Check if a model ID is an officially supported Codex model slug.
 * 
 * Allowed:
 * - Models from server catalog (getCachedVariantEfforts)
 * - Fallback slugs when server unavailable
 * - Models matching official pattern: gpt-X.Y[-codex[-max|-mini|-pro]]
 * 
 * NOT allowed:
 * - Legacy slugs with effort suffixes like "gpt-5.2-high" (use variants instead)
 * - Old slugs like "gpt-5" or "gpt-5-codex" (auto-upgraded internally)
 */
function isAllowedMetadataModel(modelId: string, accountId?: string): boolean {
	const normalized = modelId.toLowerCase().trim();
	const available = getAvailableModelSlugs(accountId);
	
	// Check if it's directly available from server/fallback
	if (available.has(normalized)) return true;
	
	// Check if it's a legacy slug that can be upgraded
	const upgraded = upgradeLegacyModelSlug(normalized, accountId);
	if (upgraded !== normalized && available.has(upgraded)) return true;
	
	// Check if it matches the official format pattern (for new models from server)
	const parsed = parseCodexMetadataModel(normalized);
	if (!parsed) return false;
	
	// Base ID must be available or match the official gpt-X.Y pattern
	// This allows new models like gpt-5.2-pro from server
	if (available.has(parsed.baseId)) return true;
	
	return /^gpt-\d+\.\d+(?:-codex)?(?:-(?:max|mini|pro))?$/.test(parsed.baseId);
}

function cloneModelMetadata(
	template: Record<string, unknown>,
	targetId: string,
): Record<string, unknown> {
	const cloned = { ...template };
	for (const field of CLONE_IDENTITY_FIELDS) {
		if (typeof cloned[field] === "string") {
			cloned[field] = targetId;
		}
	}
	return cloned;
}

function toVariantMetadata(template: Record<string, unknown>): Record<string, unknown> {
	const variant: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(template)) {
		if (VARIANT_DISALLOWED_FIELDS.has(key)) continue;
		variant[key] = value;
	}
	return variant;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeModelMetadataRegistry(models: Record<string, unknown>): boolean {
	for (const value of Object.values(models)) {
		if (!isObjectRecord(value)) continue;
		if (
			typeof value.instructions === "string" ||
			typeof value.displayName === "string" ||
			typeof value.display_name === "string"
		) {
			return true;
		}
	}
	return false;
}

function normalizeProviderModelMetadata(
	models: Record<string, unknown>,
	options?: {
		force?: boolean;
		variantEfforts?: Map<string, string[]>;
		legacyEffortBases?: Set<string>;
		accountId?: string;
	},
): void {
	if (!options?.force && !looksLikeModelMetadataRegistry(models)) return;

	const codexBases = new Map<
		string,
		{
			baseTemplate?: Record<string, unknown>;
			fallbackTemplate?: Record<string, unknown>;
			seenEfforts: Set<string>;
			variantTemplates: Map<string, Record<string, unknown>>;
		}
	>();
	const baseEntryPresent = new Set<string>();

	for (const [modelId, metadata] of Object.entries(models)) {
		const parsed = parseCodexMetadataModel(modelId);
		if (!parsed || !isObjectRecord(metadata)) continue;

		const entry = codexBases.get(parsed.baseId) ?? {
			seenEfforts: new Set<string>(),
			variantTemplates: new Map<string, Record<string, unknown>>(),
		};
		if (modelId.toLowerCase() === parsed.baseId) {
			entry.baseTemplate = metadata;
			baseEntryPresent.add(parsed.baseId);
		}
		if (!entry.fallbackTemplate) {
			entry.fallbackTemplate = metadata;
		}
		if (parsed.effort) entry.seenEfforts.add(parsed.effort);
		if (parsed.effort) {
			const prior = entry.variantTemplates.get(parsed.effort);
			entry.variantTemplates.set(parsed.effort, {
				...(prior ?? {}),
				...toVariantMetadata(metadata),
			});
		}

		const existingVariants = isObjectRecord(metadata.variants)
			? (metadata.variants as Record<string, unknown>)
			: undefined;
		if (existingVariants) {
			for (const variantName of Object.keys(existingVariants)) {
				entry.seenEfforts.add(variantName.toLowerCase());
			}
		}

		codexBases.set(parsed.baseId, entry);
	}

	for (const [baseId, entry] of codexBases) {
		const template = entry.baseTemplate ?? entry.fallbackTemplate;
		if (!template) continue;

		const baseModel =
			models[baseId] !== undefined && isObjectRecord(models[baseId])
				? (models[baseId] as Record<string, unknown>)
				: cloneModelMetadata(template, baseId);
		models[baseId] = baseModel;

		const variants = isObjectRecord(baseModel.variants)
			? (baseModel.variants as Record<string, unknown>)
			: {};

		const cachedEfforts = options?.variantEfforts?.get(baseId);
		const efforts = cachedEfforts?.length
			? new Set<string>(cachedEfforts)
			: new Set<string>([...codexVariantSet(baseId), ...entry.seenEfforts]);

		if (cachedEfforts?.length) {
			const allowed = new Set(
				cachedEfforts.map((effort) => effort.toLowerCase()),
			);
			for (const key of Object.keys(variants)) {
				if (!allowed.has(key.toLowerCase())) {
					delete variants[key];
				}
			}
		}

		for (const effort of efforts) {
			const existingVariant = isObjectRecord(variants[effort])
				? (variants[effort] as Record<string, unknown>)
				: {};
			const templateVariant = entry.variantTemplates.get(effort) ?? {};
			variants[effort] = {
				...templateVariant,
				...existingVariant,
				reasoningEffort: effort,
			};
		}
		baseModel.variants = variants;
	}

	for (const modelId of Object.keys(models)) {
		const parsed = parseCodexMetadataModel(modelId);
		if (parsed?.effort) {
			if (options?.legacyEffortBases?.has(parsed.baseId)) {
				continue;
			}
			if (!baseEntryPresent.has(parsed.baseId)) {
				continue;
			}
			delete models[modelId];
			continue;
		}
		if (!isAllowedMetadataModel(modelId, options?.accountId)) delete models[modelId];
	}
}

function collectLegacyEffortBases(models?: Record<string, unknown>): Set<string> {
	const bases = new Set<string>();
	if (!models) return bases;
	const baseEntries = new Set<string>();
	for (const modelId of Object.keys(models)) {
		const parsed = parseCodexMetadataModel(modelId);
		if (!parsed) continue;
		if (!parsed.effort) baseEntries.add(parsed.baseId);
	}
	for (const modelId of Object.keys(models)) {
		const parsed = parseCodexMetadataModel(modelId);
		if (!parsed?.effort) continue;
		if (!baseEntries.has(parsed.baseId)) bases.add(parsed.baseId);
	}
	return bases;
}


export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	let cachedAccountManager: AccountManager | null = null;
	let proactiveRefreshScheduler: RefreshScheduler | null = null;
	let cachedFetchOrchestrator: FetchOrchestrator | null = null;

	configureStorageForPluginConfig(loadPluginConfig(), process.cwd());
	void warmCodexInstructions();
	void warmCodexModelCatalog();

	const showToast = async (
		message: string,
		variant: "info" | "success" | "warning" | "error" = "info",
		quietMode: boolean = false,
	): Promise<void> => {
		if (quietMode) return;
		try {
			await client.tui.showToast({ body: { message: formatToastMessage(message), variant } });
		} catch (err) {
			// Toast failures should not crash the plugin; log for visibility.
			if (!quietMode) logCritical("Toast error", err);
		}
	};

	const buildManualOAuthFlow = (
		pkce: { verifier: string },
		expectedState: string,
		url: string,
		onSuccess?: (tokens: Extract<TokenSuccess, { type: "success" }>) => Promise<void>,
	) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInputForFlow(input, expectedState);
			if (parsed.stateStatus === "mismatch") return { type: "failed" as const };
			if (!parsed.code) return { type: "failed" as const };
			const tokens = await exchangeAuthorizationCode(parsed.code, pkce.verifier, REDIRECT_URI);
			if (tokens?.type === "success" && onSuccess) await onSuccess(tokens);
			return tokens?.type === "success" ? tokens : { type: "failed" as const };
		},
	});

	const persistAccount = async (
		token: Extract<TokenSuccess, { type: "success" }>,
		options?: { replaceExisting?: boolean },
	): Promise<void> => {
		const now = Date.now();
		const accountId =
			extractAccountId(token.idToken) ?? extractAccountId(token.access);

		// Priority for email/plan extraction: ID Token (OIDC) > Access Token.
		const email = sanitizeEmail(
			extractAccountEmail(token.idToken) ?? extractAccountEmail(token.access),
		);
		const plan =
			extractAccountPlan(token.idToken) ?? extractAccountPlan(token.access);

		await saveAccountsWithLock((stored) => {
			const base = options?.replaceExisting ? null : stored;
			const accounts = base?.accounts ? [...base.accounts] : [];
			const existingIndex = findAccountMatchIndex(accounts, { accountId, plan, email });

			if (existingIndex === -1) {
				accounts.push({
					refreshToken: token.refresh,
					accountId,
					email,
					plan,
					enabled: true,
					addedAt: now,
					lastUsed: now,
				});
			} else {
				const existing = accounts[existingIndex];
				if (existing) {
					existing.refreshToken = token.refresh;
					existing.accountId = accountId ?? existing.accountId;
					existing.email = email ?? existing.email;
					existing.plan = plan ?? existing.plan;
					if (typeof existing.enabled !== "boolean") existing.enabled = true;
					existing.lastUsed = now;
				}
			}

			const activeIndex = Math.max(
				0,
				Math.min(base?.activeIndex ?? 0, accounts.length - 1),
			);

			return {
				version: 3,
				accounts,
				activeIndex,
				activeIndexByFamily: base?.activeIndexByFamily ?? {},
			};
		});
	};

	const createEmptyStorage = (): AccountStorageV3 => ({
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {},
	});

	const updateStorageWithLock = async (
		update: (storage: AccountStorageV3) => AccountStorageV3 | null,
	): Promise<AccountStorageV3> => {
		let updated = createEmptyStorage();
		await saveAccountsWithLock((stored) => {
			const base = stored ?? createEmptyStorage();
			const next = update(base) ?? base;
			updated = next;
			return next;
		});
		return updated;
	};

	const findAccountIndex = (
		storage: AccountStorageV3,
		target: { accountId?: string; email?: string; plan?: string; refreshToken?: string },
	): number => {
		if (target.accountId && target.email && target.plan) {
			const email = target.email.toLowerCase();
			const plan = normalizePlanTypeOrDefault(target.plan);
			const matchByIdentity = storage.accounts.findIndex(
				(account) =>
					account.accountId === target.accountId &&
					account.email?.toLowerCase() === email &&
					normalizePlanTypeOrDefault(account.plan) === plan,
			);
			if (matchByIdentity !== -1) return matchByIdentity;
		}

		if (target.refreshToken) {
			const matchByToken = storage.accounts.findIndex(
				(account) => account.refreshToken === target.refreshToken,
			);
			if (matchByToken !== -1) return matchByToken;
		}

		return -1;
	};

	const removeAccountFromStorage = (
		storage: AccountStorageV3,
		target: { accountId?: string; email?: string; plan?: string; refreshToken?: string },
	): AccountStorageV3 => {
		const index = findAccountIndex(storage, target);
		if (index < 0 || index >= storage.accounts.length) return storage;
		const accounts = storage.accounts.filter((_, idx) => idx !== index);
		if (accounts.length === 0) {
			return createEmptyStorage();
		}

		let activeIndex = storage.activeIndex;
		if (activeIndex > index) {
			activeIndex -= 1;
		} else if (activeIndex === index) {
			activeIndex = Math.min(index, accounts.length - 1);
		}

		const activeIndexByFamily = { ...(storage.activeIndexByFamily ?? {}) };
		for (const [family, value] of Object.entries(activeIndexByFamily)) {
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			if (value > index) {
				activeIndexByFamily[family] = value - 1;
			} else if (value === index) {
				activeIndexByFamily[family] = activeIndex;
			}
		}

		return {
			...storage,
			accounts,
			activeIndex: Math.max(0, Math.min(activeIndex, accounts.length - 1)),
			activeIndexByFamily,
		};
	};

	const toggleAccountFromStorage = (
		storage: AccountStorageV3,
		target: { accountId?: string; email?: string; plan?: string; refreshToken?: string },
	): AccountStorageV3 => {
		const index = findAccountIndex(storage, target);
		if (index < 0 || index >= storage.accounts.length) return storage;
		return toggleAccountEnabled(storage, index) ?? storage;
	};

	const hasActiveCooldown = (
		resetTimes: Record<string, number | undefined> | undefined,
		now: number,
	): boolean => {
		if (!resetTimes) return false;
		return Object.values(resetTimes).some(
			(resetAt) => typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > now,
		);
	};

	const buildAuthMenuAccounts = (
		accounts: ReturnType<AccountManager["getAccountsSnapshot"]>,
		activeIndex: number,
	): AccountInfo[] => {
		const now = Date.now();
		return accounts.map((account) => {
			const isCurrentAccount = account.index === activeIndex;
			let status: AccountInfo["status"] = "unknown";
			if (account.cooldownReason === "auth-failure") {
				status = "expired";
			} else if (
				(account.coolingDownUntil && account.coolingDownUntil > now) ||
				hasActiveCooldown(account.rateLimitResetTimes, now)
			) {
				status = "rate-limited";
			} else if (isCurrentAccount) {
				status = "active";
			}
			return {
				index: account.index,
				accountId: account.accountId,
				email: account.email,
				plan: account.plan,
				addedAt: account.addedAt,
				lastUsed: account.lastUsed,
				enabled: account.enabled,
				status,
				isCurrentAccount,
			};
		});
	};

	const runInteractiveAuthMenu = async (options: { allowExit: boolean }): Promise<"add" | "exit"> => {
		while (true) {
			const accountManager = await AccountManager.loadFromDisk();
			const accounts = accountManager.getAccountsSnapshot();
			const activeIndex = accountManager.getActiveIndexForFamily(DEFAULT_MODEL_FAMILY);
			const menuAccounts = buildAuthMenuAccounts(accounts, activeIndex);
			const result = await runAuthMenuOnce({
				accounts: menuAccounts,
				input: process.stdin,
				output: process.stdout,
				handlers: {
					onCheckQuotas: async () => {
						await Promise.all(
							accounts.map(async (acc, index) => {
								if (acc.enabled === false) return;
								const live = accountManager.getAccountByIndex(index);
								if (!live) return;
								const auth = accountManager.toAuthDetails(live);
								if (auth.access && auth.expires > Date.now()) {
									await codexStatus.fetchFromBackend(live, auth.access);
								}
							}),
						);
						const snapshots = await codexStatus.getAllSnapshots();
						const report = renderQuotaReport(menuAccounts, snapshots, Date.now());
						process.stdout.write(report.join("\n") + "\n");
					},
					onConfigureModels: async () => {
						process.stdout.write(
							"Edit your opencode.jsonc (or opencode.json) to configure models.\n",
						);
					},
					onDeleteAll: async () => {
						await updateStorageWithLock(() => createEmptyStorage());
					},
					onToggleAccount: async (account) => {
						await updateStorageWithLock((current) =>
							toggleAccountFromStorage(current, account),
						);
					},
					onRefreshAccount: async (account) => {
						const live = accountManager.getAccountByIndex(account.index);
						if (!live || live.enabled === false) return;
						const refreshed = await accountManager.refreshAccountWithFallback(live);
						if (refreshed.type === "success") {
							if (refreshed.headers) {
								await codexStatus.updateFromHeaders(
									live,
									Object.fromEntries(refreshed.headers.entries()),
								);
							}
							const refreshedAuth = {
								type: "oauth" as const,
								access: refreshed.access,
								refresh: refreshed.refresh,
								expires: refreshed.expires,
							};
							accountManager.updateFromAuth(live, refreshedAuth);
							await accountManager.saveToDisk();
						}
					},
					onDeleteAccount: async (account) => {
						await updateStorageWithLock((current) =>
							removeAccountFromStorage(current, account),
						);
					},
				},
			});

			if (result === "add") return "add";
			if (result === "exit") {
				if (options.allowExit) return "exit";
				continue;
			}
		}
	};

	const storedAccountsForMethods = await loadAccounts();
	const hasStoredAccounts = (storedAccountsForMethods?.accounts.length ?? 0) > 0;

	const oauthMethod = {
		label: AUTH_LABELS.OAUTH,
		type: "oauth" as const,
		authorize: async (_inputs?: Record<string, string>) => {
			let replaceExisting = false;

			const existingStorage = await loadAccounts();
			if (existingStorage?.accounts?.length && process.stdin.isTTY && process.stdout.isTTY) {
				const menuResult = await runInteractiveAuthMenu({ allowExit: true });
				if (menuResult === "exit") {
					return {
						url: "about:blank",
						method: "code" as const,
						instructions: "Login cancelled.",
						callback: async () => ({ type: "failed" as const }),
					};
				}
			}

			const { pkce, state, url } = await createAuthorizationFlow();
			let serverInfo = null;
			if (!(process.env.OPENCODE_NO_BROWSER === "1")) {
				try {
					serverInfo = await startLocalOAuthServer({ state });
					openBrowserUrl(url);
				} catch {
					serverInfo = null;
				}
			}
			if (serverInfo && serverInfo.ready) {
				return {
					url,
					method: "auto" as const,
					instructions: "Sign in in your browser.",
					callback: async () => {
						const result = await serverInfo.waitForCode(state);
						serverInfo.close();
						if (!result) return { type: "failed" as const };
						const tokens = await exchangeAuthorizationCode(result.code, pkce.verifier, REDIRECT_URI);
						if (tokens?.type === "success") await persistAccount(tokens, { replaceExisting });
						return tokens?.type === "success" ? tokens : { type: "failed" as const };
					},
				};
			}
			return {
				url,
				method: "code" as const,
				instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
				callback: async (input: string) => {
					const parsed = parseAuthorizationInputForFlow(input, state);
					if (parsed.stateStatus === "mismatch") return { type: "failed" as const };
					if (!parsed.code) return { type: "failed" as const };
					const tokens = await exchangeAuthorizationCode(parsed.code, pkce.verifier, REDIRECT_URI);
					if (tokens?.type === "success") await persistAccount(tokens, { replaceExisting });
					return tokens?.type === "success" ? tokens : { type: "failed" as const };
				},
			};
		},
	};

	const manualOauthMethod = {
		label: AUTH_LABELS.OAUTH_MANUAL,
		type: "oauth" as const,
		authorize: async () => {
			const { pkce, state, url } = await createAuthorizationFlow();
			return buildManualOAuthFlow(pkce, state, url, async (tokens) => {
				await persistAccount(tokens);
			});
		},
	};

	const apiKeyMethod = { label: AUTH_LABELS.API_KEY, type: "api" as const };

	const authMethods = hasStoredAccounts
		? [oauthMethod]
		: [oauthMethod, manualOauthMethod, apiKeyMethod];

	return {
		auth: {
			provider: PROVIDER_ID,
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
					const auth = await getAuth();
					if (!isOAuthAuth(auth)) return {};
					const providerConfig = provider as { options?: Record<string, unknown>; models?: UserConfig["models"] } | undefined;
				const pluginConfig = loadPluginConfig();
				configureStorageForPluginConfig(pluginConfig, process.cwd());
				const quietMode = getQuietMode(pluginConfig);
			const accountManager = await AccountManager.loadFromDisk(auth);
			cachedAccountManager = accountManager;
			cachedFetchOrchestrator = null;

				const snapshotCount = accountManager.getAccountsSnapshot().length;
				if (snapshotCount === 0) {
					await autoQuarantineCorruptAccountsFile();
					return {};
				}

				if (providerConfig?.models && isObjectRecord(providerConfig.models)) {
					const legacyEffortBases = collectLegacyEffortBases(providerConfig.models);
					const activeAccount = accountManager.getCurrentAccountForFamily(
						DEFAULT_MODEL_FAMILY,
					);
					const variantEfforts = getCachedVariantEfforts(activeAccount?.accountId);
					normalizeProviderModelMetadata(providerConfig.models, {
						force: true,
						variantEfforts,
						legacyEffortBases,
						accountId: activeAccount?.accountId,
					});
				}

				const userConfig: UserConfig = { global: providerConfig?.options || {}, models: providerConfig?.models || {} };

				const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
				const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
				const proactiveRefreshEnabled = getProactiveTokenRefresh(pluginConfig);

				const proactiveRefreshQueue = proactiveRefreshEnabled
					? new ProactiveRefreshQueue({ 
							bufferMs: tokenRefreshSkewMs, 
							// Short interval to process the queue quickly without overwhelming the event loop.
							intervalMs: 250 
						})
					: null;

				if (proactiveRefreshScheduler) proactiveRefreshScheduler.stop();
				if (proactiveRefreshQueue) {
					proactiveRefreshScheduler = createRefreshScheduler({
						intervalMs: 1000,
						queue: proactiveRefreshQueue,
						getTasks: () => {
							const tasks = [] as Array<{ key: string; expires: number; refresh: () => Promise<TokenResult> }>;
							for (const account of accountManager.getAccountsSnapshot()) {
								if (account.enabled === false || !Number.isFinite(account.expires)) continue;
								tasks.push({
									key: `account-${account.index}`,
									expires: account.expires ?? 0,
									refresh: async () => {
										const live = accountManager.getAccountByIndex(account.index);
										if (!live || live.enabled === false) return { type: "failed" } as TokenResult;
										const refreshed = await accountManager.refreshAccountWithFallback(live);
										if (refreshed.type === "success") {
											if (refreshed.headers) codexStatus.updateFromHeaders(live, Object.fromEntries(refreshed.headers.entries())).catch(() => { });
											const refreshedAuth = { type: "oauth" as const, access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
											accountManager.updateFromAuth(live, refreshedAuth);
											await accountManager.saveToDisk();
										}
										return refreshed;
									},
								});
							}
							return tasks;
						},
					});
					proactiveRefreshScheduler.start();
				}

				const rateLimitTracker = new RateLimitTracker({
					dedupWindowMs: getRateLimitDedupWindowMs(pluginConfig),
					resetMs: getRateLimitStateResetMs(pluginConfig),
					defaultRetryMs: getDefaultRetryAfterMs(pluginConfig),
					maxBackoffMs: getMaxBackoffMs(pluginConfig),
					jitterMaxMs: getRequestJitterMaxMs(pluginConfig),
				});

				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
					if (!cachedFetchOrchestrator) {
						cachedFetchOrchestrator = new FetchOrchestrator({
							accountManager,
							pluginConfig,
							rateLimitTracker,
							healthTracker: getHealthTracker(),
							tokenTracker: getTokenTracker(),
							codexStatus,
							proactiveRefreshQueue,
							pidOffsetEnabled,
							tokenRefreshSkewMs,
							userConfig,
							quietMode,
							onAuthUpdate: async (auth) => {
								await client.auth.set({ path: { id: PROVIDER_ID }, body: auth });
							},
							showToast,
						});
					}
					return cachedFetchOrchestrator.execute(input, init);
				},
			};
		},
		methods: authMethods,
	},
		config: async (cfg) => {
			cfg.provider = cfg.provider || {};
			cfg.provider.openai = cfg.provider.openai || {};
			const openAIConfig = cfg.provider.openai as {
				models?: unknown;
				options?: Record<string, unknown>;
			};
			const options = isObjectRecord(openAIConfig.options)
				? { ...openAIConfig.options }
				: {};
			const include = Array.isArray(options.include)
				? options.include.filter((value) => typeof value === "string")
				: [];
			if (!include.includes("reasoning.encrypted_content")) {
				include.push("reasoning.encrypted_content");
			}
			options.include = include;
			if (typeof options.store !== "boolean") {
				options.store = false;
			}
			openAIConfig.options = options;
			const legacyEffortBases = collectLegacyEffortBases(
				isObjectRecord(openAIConfig.models) ? openAIConfig.models : undefined,
			);
			const internalDefaults = buildInternalModelDefaults();
			openAIConfig.models = mergeModelDefaults(openAIConfig.models, internalDefaults);
			if (isObjectRecord(openAIConfig.models)) {
				const variantEfforts = getCachedVariantEfforts();
				normalizeProviderModelMetadata(openAIConfig.models, {
					force: true,
					variantEfforts,
					legacyEffortBases,
				});
				for (const metadata of Object.values(openAIConfig.models)) {
					if (!isObjectRecord(metadata)) continue;
					for (const field of ["name", "displayName", "display_name"]) {
						const value = metadata[field];
						if (typeof value !== "string") continue;
						const lowerOauth = "(o" + "auth)";
						const lowerCodex = "(c" + "odex)";
						const oauthPattern = new RegExp(`\\(${"oauth"}\\)`, "gi");
						let next = value.replace(oauthPattern, (match) =>
							match === lowerOauth ? lowerCodex : "(Codex)",
						);
						if (/\(codex\)/i.test(next)) {
							metadata[field] = next;
							continue;
						}
						metadata[field] = `${next} (Codex)`;
					}
				}
			}

			if (cfg.command && typeof cfg.command === "object") {
				for (const key of LEGACY_CODEX_COMMAND_KEYS) {
					if (key in cfg.command) delete cfg.command[key];
				}
			}
			if (cfg.experimental?.primary_tools) {
				cfg.experimental.primary_tools = cfg.experimental.primary_tools.filter(
					(toolName) => !LEGACY_CODEX_COMMAND_KEYS.has(toolName),
				);
			}
		},
		tool: {},
	};
};

export default OpenAIAuthPlugin;
