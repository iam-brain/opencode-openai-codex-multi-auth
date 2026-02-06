/**
 * OpenAI ChatGPT (Codex) OAuth Plugin
 */

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
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
	MODEL_FAMILIES,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";

import {
	AccountManager,
	extractAccountEmail,
	extractAccountId,
	extractAccountPlan,
	formatAccountLabel,
	isOAuthAuth,
	sanitizeEmail,
} from "./lib/accounts.js";
import {
	promptLoginMode,
	promptManageAccounts,
} from "./lib/cli.js";
import { normalizePlanTypeOrDefault } from "./lib/plan-utils.js";
import {
	configureStorageForCurrentCwd,
	configureStorageForPluginConfig,
} from "./lib/storage-scope.js";
import {
	getStoragePath,
	getStorageScope,
	autoQuarantineCorruptAccountsFile,
	loadAccounts,
	quarantineAccounts,
	replaceAccountsFile,
	saveAccounts,
	saveAccountsWithLock,
	toggleAccountEnabled,
} from "./lib/storage.js";
import { findAccountMatchIndex } from "./lib/account-matching.js";

import type { AccountStorageV3, OAuthAuthDetails, TokenResult, TokenSuccess, UserConfig } from "./lib/types.js";
import { getHealthTracker, getTokenTracker } from "./lib/rotation.js";
import { RateLimitTracker } from "./lib/rate-limit.js";
import { codexStatus, type CodexRateLimitSnapshot } from "./lib/codex-status.js";
import { renderObsidianDashboard } from "./lib/codex-status-ui.js";
import {
	ProactiveRefreshQueue,
	createRefreshScheduler,
	type RefreshScheduler,
} from "./lib/refresh-queue.js";
import { formatToastMessage } from "./lib/formatting.js";
import { logCritical } from "./lib/logger.js";
import { FetchOrchestrator } from "./lib/fetch-orchestrator.js";

const LEGACY_ALLOWED_METADATA_MODELS = new Set([
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5-codex",
	"codex-mini-latest",
]);

const CODEX_METADATA_REGEX =
	/^(gpt-\d+(?:\.\d+)*-codex(?:-(?:max|mini))?)(?:-(none|minimal|low|medium|high|xhigh))?$/i;

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

function isAllowedMetadataModel(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	if (LEGACY_ALLOWED_METADATA_MODELS.has(normalized)) return true;
	return parseCodexMetadataModel(normalized) !== undefined;
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
	options?: { force?: boolean },
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

	for (const [modelId, metadata] of Object.entries(models)) {
		const parsed = parseCodexMetadataModel(modelId);
		if (!parsed || !isObjectRecord(metadata)) continue;

		const entry = codexBases.get(parsed.baseId) ?? {
			seenEfforts: new Set<string>(),
			variantTemplates: new Map<string, Record<string, unknown>>(),
		};
		if (modelId.toLowerCase() === parsed.baseId) {
			entry.baseTemplate = metadata;
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

		const efforts = new Set<string>([
			...codexVariantSet(baseId),
			...entry.seenEfforts,
		]);

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
			delete models[modelId];
			continue;
		}
		if (!isAllowedMetadataModel(modelId)) delete models[modelId];
	}
}


export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	let cachedAccountManager: AccountManager | null = null;
	let proactiveRefreshScheduler: RefreshScheduler | null = null;
	let cachedFetchOrchestrator: FetchOrchestrator | null = null;

	configureStorageForPluginConfig(loadPluginConfig(), process.cwd());

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

	const buildExistingAccountLabels = (storage: AccountStorageV3) =>
		storage.accounts.map((account, index) => ({
			index,
			email: account.email,
			plan: account.plan,
			accountId: account.accountId,
			refreshToken: account.refreshToken,
			enabled: account.enabled,
		}));

	const storedAccountsForMethods = await loadAccounts();
	const hasStoredAccounts = (storedAccountsForMethods?.accounts.length ?? 0) > 0;

	const oauthMethod = {
		label: AUTH_LABELS.OAUTH,
		type: "oauth" as const,
		authorize: async (inputs?: Record<string, string>) => {
			let replaceExisting = false;

			if (inputs) {
				let existingStorage = await loadAccounts();
				if (existingStorage?.accounts?.length) {
					while (true) {
						const existingLabels = buildExistingAccountLabels(existingStorage);
						const mode = await promptLoginMode(existingLabels);

						if (mode === "manage") {
							const action = await promptManageAccounts(existingLabels);
							if (!action) {
								continue;
							}

						if (action.action === "toggle") {
							existingStorage = await updateStorageWithLock((current) =>
								toggleAccountFromStorage(current, action.target),
							);
						} else {
							existingStorage = await updateStorageWithLock((current) =>
								removeAccountFromStorage(current, action.target),
							);
						}

							if (existingStorage.accounts.length === 0) {
								replaceExisting = true;
								break;
							}
							continue;
						}

						replaceExisting = mode === "fresh";
						break;
					}
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
					if (providerConfig?.models && isObjectRecord(providerConfig.models)) {
						normalizeProviderModelMetadata(providerConfig.models, { force: true });
					}

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
			const openAIModels = (cfg as { provider?: { openai?: { models?: unknown } } })?.provider?.openai?.models;
			if (openAIModels && isObjectRecord(openAIModels)) {
				normalizeProviderModelMetadata(openAIModels, { force: true });
			}

			cfg.command = cfg.command || {};
			cfg.command["codex-status"] = {
				template: "Run the codex-status tool and output the result EXACTLY as returned by the tool, without any additional text or commentary.",
				description: "List all configured OpenAI Codex accounts and their current rate limits.",
			};
			cfg.command["codex-switch-accounts"] = {
				template: "Run the codex-switch-accounts tool with index $ARGUMENTS and output the result EXACTLY as returned by the tool, without any additional text or commentary.",
				description: "Switch active OpenAI account by index (1-based).",
			};
			cfg.command["codex-toggle-account"] = {
				template: "Run the codex-toggle-account tool with index $ARGUMENTS and output the result EXACTLY as returned by the tool, without any additional text or commentary.",
				description: "Enable or disable an OpenAI account by index (1-based).",
			};
			cfg.command["codex-remove-account"] = {
				template: "Run the codex-remove-account tool with index $ARGUMENTS and confirm: true.",
				description: "Remove an OpenAI account by index (1-based).",
			};

			cfg.experimental = cfg.experimental || {};
			cfg.experimental.primary_tools = cfg.experimental.primary_tools || [];
			for (const t of ["codex-status", "codex-switch-accounts", "codex-toggle-account", "codex-remove-account"]) {
				if (!cfg.experimental.primary_tools.includes(t)) {
					cfg.experimental.primary_tools.push(t);
				}
			}
		},
		tool: {
		"codex-status": tool({
			description: "List all configured OpenAI Codex accounts and their current rate limits.",
			args: {},
			async execute() {
				configureStorageForCurrentCwd();
				const accountManager = await AccountManager.loadFromDisk();
				const accounts = accountManager.getAccountsSnapshot();
				const { scope, storagePath } = getStorageScope();
				if (accounts.length === 0) return [`OpenAI Codex Status`, ``, `  Scope: ${scope}`, `  Accounts: 0`, ``, `Add accounts:`, `  opencode auth login`, ``, `Storage: ${storagePath}`].join("\n");

				await Promise.all(accounts.map(async (acc, index) => {
					if (acc.enabled === false) return;
					const live = accountManager.getAccountByIndex(index);
					if (!live) return;

					try {
					const auth = accountManager.toAuthDetails(live);
					if (auth.access && auth.expires > Date.now()) {
						await codexStatus.fetchFromBackend(live, auth.access);
					}
					} catch {
					}
				}));

					const enabledCount = accounts.filter(a => a.enabled !== false).length;
				const activeIndex = accountManager.getActiveIndexForFamily(DEFAULT_MODEL_FAMILY);
					const snapshots = await codexStatus.getAllSnapshots();

					const lines: string[] = [
						`OpenAI Codex Status`, 
						``, 
						`  Scope: ${scope}`, 
						`  Accounts: ${enabledCount}/${accounts.length} enabled`, 
						``,
						...renderObsidianDashboard(accounts, activeIndex, snapshots)
					];

					lines.push(``);
					lines.push(`Storage: ${storagePath}`);
					return lines.join("\n");
				},
			}),
			"codex-switch-accounts": tool({
				description: "Switch active OpenAI account by index (1-based).",
				args: { index: tool.schema.number().describe("Account number (1-based)") },
				async execute({ index }) {
					configureStorageForCurrentCwd();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) return "No OpenAI accounts configured.";
					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= storage.accounts.length) return `Invalid account number: ${index}. Valid range: 1-${storage.accounts.length}`;
					storage.activeIndex = targetIndex;
					storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
					for (const family of MODEL_FAMILIES) storage.activeIndexByFamily[family] = targetIndex;
					await saveAccounts(storage, { preserveRefreshTokens: true });
					if (cachedAccountManager) { cachedAccountManager.setActiveIndex(targetIndex); await cachedAccountManager.saveToDisk(); }
					return `Switched to ${formatAccountLabel(storage.accounts[targetIndex], targetIndex)}`;
				},
			}),
			"codex-toggle-account": tool({
				description: "Enable or disable an OpenAI account by index (1-based).",
				args: { index: tool.schema.number().describe("Account number (1-based)") },
				async execute({ index }) {
					configureStorageForCurrentCwd();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) return "No OpenAI accounts configured.";
					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= storage.accounts.length) return `Invalid account number: ${index}. Valid range: 1-${storage.accounts.length}`;
					const updated = toggleAccountEnabled(storage, targetIndex);
					if (!updated) return `Failed to toggle account number: ${index}`;
					await saveAccounts(updated, { preserveRefreshTokens: true });
					if (cachedAccountManager) {
						const live = cachedAccountManager.getAccountByIndex(targetIndex);
						if (live) { live.enabled = updated.accounts[targetIndex]?.enabled !== false; await cachedAccountManager.saveToDisk(); }
					}
					return `${updated.accounts[targetIndex]?.enabled !== false ? "Enabled" : "Disabled"} ${formatAccountLabel(updated.accounts[targetIndex], targetIndex)}`;
				},
			}),
			"codex-remove-account": tool({
				description: "Remove an OpenAI account by index (1-based). This is permanent.",
				args: {
					index: tool.schema.number().describe("Account number (1-based)"),
					confirm: tool.schema.boolean().optional().describe("Confirm removal (required)"),
				},
				async execute({ index, confirm }) {
					if (!confirm) {
						return "To remove account, call with confirm: true";
					}
					configureStorageForCurrentCwd();
					const accountManager = cachedAccountManager ?? await AccountManager.loadFromDisk();
					const snapshot = accountManager.getAccountsSnapshot();
					if (snapshot.length === 0) return "No OpenAI accounts configured.";

					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= snapshot.length) {
						return `Invalid account number: ${index}.`;
					}
					const account = accountManager.getAccountByIndex(targetIndex);
					if (!account) return `Invalid account number: ${index}.`;

					const label = formatAccountLabel(account, targetIndex);
					const success = await accountManager.removeAccountByIndex(targetIndex);

					if (!success) return `Failed to remove account ${index}.`;
					
					return `Removed ${label}.`;
				},
			}),
		},
	};
};

export default OpenAIAuthPlugin;
