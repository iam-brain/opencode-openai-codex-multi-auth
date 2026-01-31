/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for opencode
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @author numman-ali
 * @repository https://github.com/numman-ali/opencode-openai-codex-auth
 */

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInputForFlow,
	REDIRECT_URI,
	refreshAccessToken,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import {
	getAccountSelectionStrategy,
	getCodexMode,
	getDefaultRetryAfterMs,
	getMaxBackoffMs,
	getMaxCacheFirstWaitSeconds,
	getPidOffsetEnabled,
	getQuietMode,
	getRateLimitDedupWindowMs,
	getRateLimitStateResetMs,
	getRateLimitToastDebounceMs,
	getRequestJitterMaxMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
	getSchedulingMode,
	getSwitchOnFirstRateLimit,
	getTokenRefreshSkewMs,
	loadPluginConfig,
} from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	ERROR_MESSAGES,
	HTTP_STATUS,
	LOG_STAGES,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
import {
	createCodexHeaders,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	rewriteUrlForCodex,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import {
	AccountManager,
	extractAccountEmail,
	extractAccountId,
	extractAccountPlan,
	formatAccountLabel,
	formatWaitTime,
	isOAuthAuth,
	needsIdentityHydration,
	sanitizeEmail,
} from "./lib/accounts.js";
import {
	promptAddAnotherAccount,
	promptLoginMode,
	promptManageAccounts,
	promptOAuthCallbackValue,
	promptRepairAccounts,
} from "./lib/cli.js";
import { withTerminalModeRestored } from "./lib/terminal.js";
import {
	configureStorageForCurrentCwd,
	configureStorageForPluginConfig,
} from "./lib/storage-scope.js";
import {
	getStoragePath,
	getStorageScope,
	autoQuarantineCorruptAccountsFile,
	inspectAccountsFile,
	loadAccounts,
	quarantineAccounts,
	quarantineCorruptFile,
	replaceAccountsFile,
	saveAccounts,
	toggleAccountEnabled,
	writeQuarantineFile,
} from "./lib/storage.js";
import { findAccountMatchIndex } from "./lib/account-matching.js";
import { getModelFamily, MODEL_FAMILIES, type ModelFamily } from "./lib/prompts/codex.js";
import type { AccountStorageV3, OAuthAuthDetails, TokenResult, TokenSuccess, UserConfig } from "./lib/types.js";
import { getHealthTracker, getTokenTracker } from "./lib/rotation.js";
import { RateLimitTracker, decideRateLimitAction, parseRateLimitReason } from "./lib/rate-limit.js";
import { codexStatus } from "./lib/codex-status.js";
import {
	ProactiveRefreshQueue,
	createRefreshScheduler,
	type RefreshScheduler,
} from "./lib/refresh-queue.js";
import { formatRateLimitStatusMessage, formatToastMessage } from "./lib/formatting.js";

const RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS = 5_000;
const AUTH_FAILURE_COOLDOWN_MS = 60_000;
const MAX_ACCOUNTS = 10;
const AUTH_DEBUG_ENABLED = process.env.OPENCODE_OPENAI_AUTH_DEBUG === "1";

const debugAuth = (...args: unknown[]): void => {
	if (!AUTH_DEBUG_ENABLED) return;
	console.debug(...args);
};

function shouldRefreshToken(auth: OAuthAuthDetails, skewMs: number): boolean {
	return !auth.access || auth.expires <= Date.now() + Math.max(0, Math.floor(skewMs));
}

function parseRetryAfterMs(headers: Headers): number | null {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const parsed = Number(retryAfterMs);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return null;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
	return null;
}

/**
 * OpenAI Codex OAuth authentication plugin for opencode
 *
 * This plugin enables opencode to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-openai-codex-auth"],
 *   "model": "openai/gpt-5-codex"
 * }
 * ```
 */
export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	let cachedAccountManager: AccountManager | null = null;
	let proactiveRefreshScheduler: RefreshScheduler | null = null;

	configureStorageForPluginConfig(loadPluginConfig(), process.cwd());

	const showToast = async (
		message: string,
		variant: "info" | "success" | "warning" | "error" = "info",
		quietMode: boolean = false,
	): Promise<void> => {
		if (quietMode) return;
		try {
			await client.tui.showToast({ body: { message: formatToastMessage(message), variant } });
		} catch {
			// ignore (non-TUI contexts)
		}
	};

	const buildManualOAuthFlow = (
		pkce: { verifier: string },
		expectedState: string,
		url: string,
		onSuccess?: (tokens: TokenOk) => Promise<void>,
	) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInputForFlow(input, expectedState);
			if (parsed.stateStatus === "mismatch") {
				return { type: "failed" as const };
			}
			if (!parsed.code) {
				return { type: "failed" as const };
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type === "success" && onSuccess) {
				await onSuccess(tokens);
			}
			return tokens?.type === "success" ? tokens : { type: "failed" as const };
		},
	});

	type TokenOk = Extract<TokenSuccess, { type: "success" }>;

	const persistAccount = async (token: TokenOk): Promise<void> => {
		debugAuth("[PersistAccount] Starting account persistence");
		const now = Date.now();
		const stored = await loadAccounts();
		const accounts = stored?.accounts ? [...stored.accounts] : [];
		const accountId = extractAccountId(token.access);
		const email = sanitizeEmail(extractAccountEmail(token.idToken ?? token.access));
		const plan = extractAccountPlan(token.idToken ?? token.access);
		if (!accountId || !email || !plan) {
			debugAuth("[PersistAccount] Missing account identity fields; persisting legacy entry");
		}

		debugAuth(
			`[PersistAccount] Account details - accountId: ${accountId}, email: ${email}, plan: ${plan}, existing accounts: ${accounts.length}`,
		);

		const existingIndex = findAccountMatchIndex(accounts, { accountId, plan, email });

		debugAuth(`[PersistAccount] Match index: ${existingIndex}`);

		if (existingIndex === -1) {
			debugAuth("[PersistAccount] Adding new account");
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
			debugAuth(`[PersistAccount] Updating existing account at index ${existingIndex}`);
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

		const activeIndex = stored?.activeIndex ?? 0;
		const storageToSave: AccountStorageV3 = {
			version: 3,
			accounts,
			activeIndex: Math.max(0, Math.min(activeIndex, accounts.length - 1)),
			activeIndexByFamily: stored?.activeIndexByFamily ?? {},
		};

		debugAuth(`[PersistAccount] Saving storage with ${accounts.length} accounts`);
		await saveAccounts(storageToSave);
		debugAuth("[PersistAccount] Account persistence completed");
	};

	return {
		auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
			 * 1. Validates OAuth authentication
			 * 2. Extracts ChatGPT account ID from access token
			 * 3. Loads user configuration from opencode.json
			 * 4. Fetches Codex system instructions from GitHub (cached)
			 * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from opencode.json
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();

				if (!isOAuthAuth(auth)) {
					return {};
				}

				const pluginConfig = loadPluginConfig();
				configureStorageForPluginConfig(pluginConfig, process.cwd());
				const quietMode = getQuietMode(pluginConfig);

				const accountManager = await AccountManager.loadFromDisk(auth);
				cachedAccountManager = accountManager;
				if (accountManager.getAccountCount() === 0) {
					const quarantinePath = await autoQuarantineCorruptAccountsFile();
					if (quarantinePath) {
						await showToast(
							"Accounts file was corrupted and has been quarantined. Run `opencode auth login`.",
							"warning",
							quietMode,
						);
					}
					logDebug(`[${PLUGIN_NAME}] No OAuth accounts available (run opencode auth login)`);
					return {};
				}
				// Extract user configuration (global + per-model options)
				const providerConfig = provider as
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
					| undefined;
				const userConfig: UserConfig = {
					global: providerConfig?.options || {},
					models: providerConfig?.models || {},
				};

				const codexMode = getCodexMode(pluginConfig);
				const accountSelectionStrategy = getAccountSelectionStrategy(pluginConfig);
				const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
				const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
				const proactiveRefreshEnabled = (() => {
					const rawConfig = pluginConfig as Record<string, unknown>;
					const configFlag = rawConfig["proactive_token_refresh"] ?? rawConfig["proactiveTokenRefresh"];
					const envFlag = process.env.CODEX_AUTH_PROACTIVE_TOKEN_REFRESH;
					if (envFlag === "1" || envFlag === "true") return true;
					if (envFlag === "0" || envFlag === "false") return false;
					return Boolean(configFlag);
				})();
				const toastDebounceMs = getRateLimitToastDebounceMs(pluginConfig);
				const retryAllAccountsRateLimited = getRetryAllAccountsRateLimited(pluginConfig);
				const retryAllAccountsMaxWaitMs = getRetryAllAccountsMaxWaitMs(pluginConfig);
				const retryAllAccountsMaxRetries = getRetryAllAccountsMaxRetries(pluginConfig);
				const schedulingMode = getSchedulingMode(pluginConfig);
				const maxCacheFirstWaitSeconds = getMaxCacheFirstWaitSeconds(pluginConfig);
				const switchOnFirstRateLimit = getSwitchOnFirstRateLimit(pluginConfig);
				const rateLimitDedupWindowMs = getRateLimitDedupWindowMs(pluginConfig);
				const rateLimitStateResetMs = getRateLimitStateResetMs(pluginConfig);
				const defaultRetryAfterMs = getDefaultRetryAfterMs(pluginConfig);
				const maxBackoffMs = getMaxBackoffMs(pluginConfig);
				const requestJitterMaxMs = getRequestJitterMaxMs(pluginConfig);
				const maxCacheFirstWaitMs = Math.max(0, Math.floor(maxCacheFirstWaitSeconds * 1000));
				const proactiveRefreshQueue = proactiveRefreshEnabled
					? new ProactiveRefreshQueue({ bufferMs: tokenRefreshSkewMs, intervalMs: 250 })
					: null;
				if (proactiveRefreshScheduler) {
					proactiveRefreshScheduler.stop();
					proactiveRefreshScheduler = null;
				}
				if (proactiveRefreshQueue) {
					proactiveRefreshScheduler = createRefreshScheduler({
						intervalMs: 1000,
						queue: proactiveRefreshQueue,
						getTasks: () => {
							const tasks = [] as Array<{
								key: string;
								expires: number;
								refresh: () => Promise<TokenResult>;
							}>;
							for (const account of accountManager.getAccountsSnapshot()) {
								if (account.enabled === false) continue;
								if (!Number.isFinite(account.expires)) continue;
								tasks.push({
									key: `account-${account.index}`,
									expires: account.expires ?? 0,
									refresh: async () => {
										const live = accountManager.getAccountByIndex(account.index);
										if (!live || live.enabled === false) return { type: "failed" } as TokenResult;
										const refreshed = await accountManager.refreshAccountWithFallback(live);
										if (refreshed.type !== "success") return refreshed;
										const refreshedAuth = {
											type: "oauth" as const,
											access: refreshed.access,
											refresh: refreshed.refresh,
											expires: refreshed.expires,
										};
										accountManager.updateFromAuth(live, refreshedAuth);
										await accountManager.saveToDisk();
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
					dedupWindowMs: rateLimitDedupWindowMs,
					resetMs: rateLimitStateResetMs,
					defaultRetryMs: defaultRetryAfterMs,
					maxBackoffMs,
					jitterMaxMs: requestJitterMaxMs,
				});

				// Return SDK configuration
				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
					/**
					 * Custom fetch implementation for Codex API
					 *
					 * Handles:
					 * - Token refresh when expired
					 * - URL rewriting for Codex backend
					 * - Request body transformation
					 * - OAuth header injection
					 * - SSE to JSON conversion for non-tool requests
					 * - Error handling and logging
					 *
					 * @param input - Request URL or Request object
					 * @param init - Request options
					 * @returns Response from Codex API
					 */
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						// Step 2: Extract and rewrite URL for Codex backend
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						// Step 3: Transform request body with model-specific Codex instructions
						// Instructions are fetched per model family (codex-max, codex, gpt-5.1)
						// Capture original stream value before transformation
						// generateText() sends no stream field, streamText() sends stream=true
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;

						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;
						const model = transformation?.body.model;
						const modelFamily: ModelFamily = model ? getModelFamily(model) : "gpt-5.1";
						const usePidOffset = pidOffsetEnabled && accountManager.getAccountCount() > 1;

						const abortSignal = requestInit?.signal ?? init?.signal ?? null;
						const sleep = (ms: number): Promise<void> =>
							new Promise((resolve, reject) => {
								if (abortSignal?.aborted) {
									reject(new Error("Aborted"));
									return;
								}
								const timeout = setTimeout(() => {
									cleanup();
									resolve();
								}, ms);
								const onAbort = () => {
									cleanup();
									reject(new Error("Aborted"));
								};
								const cleanup = () => {
									clearTimeout(timeout);
									abortSignal?.removeEventListener("abort", onAbort);
								};
								abortSignal?.addEventListener("abort", onAbort, { once: true });
							});

						let allRateLimitedRetries = 0;
						let autoRepairAttempted = false;

						while (true) {
							const accountCount = accountManager.getAccountCount();
							if (!autoRepairAttempted && accountCount === 0) {
								const legacyAccounts = accountManager.getLegacyAccounts();
								if (legacyAccounts.length > 0) {
									autoRepairAttempted = true;
									const repair = await accountManager.repairLegacyAccounts();
									const snapshot = accountManager.getStorageSnapshot();
									let quarantinePath: string | null = null;
									if (repair.quarantined.length > 0) {
										const quarantinedTokens = new Set(
											repair.quarantined.map((account) => account.refreshToken),
										);
										const quarantineEntries = snapshot.accounts.filter((account) =>
											quarantinedTokens.has(account.refreshToken),
										);
										const quarantineResult = await quarantineAccounts(
											snapshot,
											quarantineEntries,
											"legacy-auto-repair-failed",
										);
										quarantinePath = quarantineResult.quarantinePath;
										accountManager.removeAccountsByRefreshToken(quarantinedTokens);
									} else {
										await replaceAccountsFile(snapshot);
									}
								if (repair.quarantined.length > 0 && quarantinePath) {
									logDebug(
										`[${PLUGIN_NAME}] Auto-repair quarantined: ${quarantinePath}`,
									);
									await showToast(
										`Auto-repair failed for ${repair.quarantined.length} account(s).`,
										"warning",
										quietMode,
									);
								} else if (repair.repaired.length > 0) {
										await showToast(
											`Auto-repaired ${repair.repaired.length} account(s).`,
											"success",
											quietMode,
										);
									}
									continue;
								}
							}
							const attempted = new Set<number>();

							while (attempted.size < Math.max(1, accountCount)) {
								const account = accountManager.getCurrentOrNextForFamily(
									modelFamily,
									model,
									accountSelectionStrategy,
									usePidOffset,
								);
								if (!account || attempted.has(account.index)) break;
								attempted.add(account.index);

								let accountAuth = accountManager.toAuthDetails(account);
								const tokenExpired = !accountAuth.access || accountAuth.expires <= Date.now();
								const runRefresh = async (): Promise<TokenResult> => {
									const refreshed = await accountManager.refreshAccountWithFallback(account);
									if (refreshed.type !== "success") return refreshed;
									const refreshedAuth = {
										type: "oauth" as const,
										access: refreshed.access,
										refresh: refreshed.refresh,
										expires: refreshed.expires,
									};
									accountManager.updateFromAuth(account, refreshedAuth);
									await accountManager.saveToDisk();
									await client.auth.set({
										path: { id: PROVIDER_ID },
										body: refreshedAuth,
									});
									return refreshed;
								};

								if (shouldRefreshToken(accountAuth, tokenRefreshSkewMs)) {
									if (proactiveRefreshQueue && !tokenExpired) {
										void proactiveRefreshQueue.enqueue({
											key: `account-${account.index}`,
											expires: accountAuth.expires,
											refresh: runRefresh,
										});
									} else {
										const refreshed = await runRefresh();
										if (refreshed.type !== "success") {
											accountManager.markAccountCoolingDown(
												account,
												AUTH_FAILURE_COOLDOWN_MS,
												"auth-failure",
											);
											await accountManager.saveToDisk();
											await showToast(
												`Auth refresh failed. Cooling down ${formatAccountLabel(account, account.index)}.`,
												"warning",
												quietMode,
											);
											continue;
										}

										accountAuth = {
											type: "oauth",
											access: refreshed.access,
											refresh: refreshed.refresh,
											expires: refreshed.expires,
										};
									}
								}

								const accountId = account.accountId ?? extractAccountId(accountAuth.access);
								if (!accountId) {
									accountManager.markAccountCoolingDown(
										account,
										AUTH_FAILURE_COOLDOWN_MS,
										"auth-failure",
									);
									await accountManager.saveToDisk();
									continue;
								}
								account.accountId = accountId;

								if (
									accountCount > 1 &&
									accountManager.shouldShowAccountToast(account.index, toastDebounceMs)
								) {
									await showToast(
										`Using ${formatAccountLabel(account, account.index)} (${account.index + 1}/${accountCount})`,
										"info",
										quietMode,
									);
									accountManager.markToastShown(account.index);
								}

								const headers = createCodexHeaders(requestInit, accountId, accountAuth.access, {
									model,
									promptCacheKey: transformation?.body?.prompt_cache_key,
								});

								let tokenConsumed = false;
								if (accountSelectionStrategy === "hybrid") {
									tokenConsumed = getTokenTracker().consume(account.index);
									if (!tokenConsumed) {
										// Token bucket says "rest this account"; try another.
										continue;
									}
								}

								while (true) {
									let res: Response;
									try {
										res = await fetch(url, { ...requestInit, headers });
										// Update Codex rate limit snapshot from response headers
										const codexHeaders: Record<string, string> = {};
										res.headers.forEach((val, key) => {
											if (key.toLowerCase().startsWith("x-codex-")) {
												codexHeaders[key] = val;
											}
										});
										codexStatus.updateFromHeaders(account, codexHeaders);
									} catch (err) {
										if (tokenConsumed) {
											getTokenTracker().refund(account.index);
											tokenConsumed = false;
										}
										if (accountSelectionStrategy === "hybrid") {
											getHealthTracker().recordFailure(account.index);
										}
										throw err;
									}

									logRequest(LOG_STAGES.RESPONSE, {
										status: res.status,
										ok: res.ok,
										statusText: res.statusText,
										headers: Object.fromEntries(res.headers.entries()),
										accountIndex: account.index,
										accountCount,
									});

							if (res.ok) {
								if (accountSelectionStrategy === "hybrid") {
									getHealthTracker().recordSuccess(account.index);
								}
								accountManager.markAccountUsed(account.index);
								return await handleSuccessResponse(res, isStreaming);
							}

									const handled = await handleErrorResponse(res);
									if (handled.status !== HTTP_STATUS.TOO_MANY_REQUESTS) {
										if (accountSelectionStrategy === "hybrid") {
											getHealthTracker().recordFailure(account.index);
										}
										return handled;
									}

							const retryAfterMs = parseRetryAfterMs(handled.headers);
							let responseText = "";
							try {
								responseText = await handled.clone().text();
							} catch {
								responseText = "";
							}
							const reason = parseRateLimitReason(handled.status, responseText);
							const trackerKey = `${account.index}:${modelFamily}:${model ?? ""}`;
							const backoff = rateLimitTracker.getBackoff(trackerKey, reason, retryAfterMs);
							const decision = decideRateLimitAction({
								schedulingMode,
								accountCount,
								maxCacheFirstWaitMs,
								switchOnFirstRateLimit,
								shortRetryThresholdMs: RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
								backoff,
							});
							if (tokenConsumed) {
								getTokenTracker().refund(account.index);
								tokenConsumed = false;
							}
							if (accountSelectionStrategy === "hybrid") {
								getHealthTracker().recordRateLimit(account.index);
							}
							accountManager.markRateLimited(account, backoff.delayMs, modelFamily, model);
							const shouldPersistRateLimit = !backoff.isDuplicate;

							if (decision.action === "wait") {
								if (shouldPersistRateLimit) {
									await accountManager.saveToDisk();
									await showToast(
										`Rate limited. Retrying in ${formatWaitTime(decision.delayMs)}...`,
										"warning",
										quietMode,
									);
								}
								if (decision.delayMs > 0) {
									await sleep(decision.delayMs);
								}
								continue;
							}

							accountManager.markSwitched(account, "rate-limit", modelFamily);
							if (shouldPersistRateLimit) {
								await accountManager.saveToDisk();
								await showToast(
									`Rate limited. Switching accounts (retry in ${formatWaitTime(decision.delayMs)}).`,
									"warning",
									quietMode,
								);
							}
							break;
						}
					}

							const waitMs = await accountManager.getMinWaitTimeForFamilyWithHydration(
								modelFamily,
								model,
							);
							if (
								retryAllAccountsRateLimited &&
								accountManager.getAccountCount() > 0 &&
								waitMs > 0 &&
								(retryAllAccountsMaxWaitMs === 0 || waitMs <= retryAllAccountsMaxWaitMs) &&
								allRateLimitedRetries < retryAllAccountsMaxRetries
							) {
								allRateLimitedRetries += 1;
								await showToast(
									`All ${accountManager.getAccountCount()} account(s) are rate-limited. Waiting ${formatWaitTime(waitMs)}...`,
									"warning",
									quietMode,
								);
								await sleep(waitMs);
								continue;
							}

							const message = formatRateLimitStatusMessage({
								accountCount: accountManager.getAccountCount(),
								waitMs,
								storagePath: getStoragePath(),
							});
							return new Response(JSON.stringify({ error: { message } }), {
								status: 429,
								headers: { "content-type": "application/json; charset=utf-8" },
							});
						}

					},
				};
			},
			methods: [
				{
					label: AUTH_LABELS.OAUTH,
					type: "oauth" as const,
					/**
					 * OAuth authorization flow
					 *
					 * Steps:
					 * 1. Generate PKCE challenge and state for security
					 * 2. Start local OAuth callback server on port 1455
					 * 3. Open browser to OpenAI authorization page
					 * 4. Wait for user to complete login
					 * 5. Exchange authorization code for tokens
					 *
					 * @returns Authorization flow configuration
					 */
						authorize: async (inputs?: Record<string, string>) => {
					const pluginConfig = loadPluginConfig();
					configureStorageForPluginConfig(pluginConfig, process.cwd());
					const quietMode = getQuietMode(pluginConfig);
					const isCliFlow = Boolean(inputs);
					const notifyRepairResult = async (message: string) => {
						if (isCliFlow) {
							console.log(`\n${message}\n`);
							return;
						}
						await showToast(message, "info", quietMode);
					};
					const maybeRepairAccounts = async (): Promise<AccountStorageV3 | null> => {
						const inspection = await inspectAccountsFile();
						if (inspection.status === "missing" || inspection.status === "ok") {
							return null;
						}
						const corruptCount =
							inspection.status === "corrupt-file"
								? 1
								: inspection.corruptEntries.length;
						const legacyCount =
							inspection.status === "needs-repair" ? inspection.legacyEntries.length : 0;
						const shouldRepair = await promptRepairAccounts({
							legacyCount,
							corruptCount,
						});
						if (!shouldRepair) return null;

						const quarantinePaths: string[] = [];
						if (inspection.status === "corrupt-file") {
							const quarantinePath = await quarantineCorruptFile();
							if (quarantinePath) {
								quarantinePaths.push(quarantinePath);
								logDebug(
									`[${PLUGIN_NAME}] Accounts file quarantined: ${quarantinePath}`,
								);
								await notifyRepairResult("Accounts file was corrupted and quarantined.");
							}
							return await loadAccounts();
						}

						if (inspection.corruptEntries.length > 0) {
							const quarantinePath = await writeQuarantineFile(
								inspection.corruptEntries,
								"corrupt-entry",
							);
							quarantinePaths.push(quarantinePath);
						}

						const storage = await loadAccounts();
						if (!storage) {
							await notifyRepairResult("Repair skipped: no valid accounts found.");
							return null;
						}
						const manager = new AccountManager(undefined, storage);
						const repair = await manager.repairLegacyAccounts();
						const snapshot = manager.getStorageSnapshot();
						let updatedStorage = snapshot;
						if (repair.quarantined.length > 0) {
							const quarantinedTokens = new Set(
								repair.quarantined.map((account) => account.refreshToken),
							);
							const quarantineEntries = snapshot.accounts.filter((account) =>
								quarantinedTokens.has(account.refreshToken),
							);
							const quarantineResult = await quarantineAccounts(
								snapshot,
								quarantineEntries,
								"legacy-repair-failed",
							);
							updatedStorage = quarantineResult.storage;
							quarantinePaths.push(quarantineResult.quarantinePath);
						} else {
							await replaceAccountsFile(snapshot);
						}
						const summaryParts = [
							`Repaired ${repair.repaired.length}`,
							`quarantined ${repair.quarantined.length}`,
						];
						if (quarantinePaths.length > 0) {
							logDebug(
								`[${PLUGIN_NAME}] Repair quarantine paths: ${quarantinePaths.join(", ")}`,
							);
						}
						await notifyRepairResult(
							`Account repair complete. ${summaryParts.join(", ")}.`,
						);
						return updatedStorage;
					};
					const repairedStorage = await maybeRepairAccounts();

					// CLI flow (`opencode auth login`) passes inputs; TUI does not.
					if (isCliFlow) {
						debugAuth("[OAuthAuthorize] Starting OAuth flow in CLI mode");
						return await withTerminalModeRestored(async () => {
							const noBrowser =
								inputs?.noBrowser === "true" ||
								inputs?.["no-browser"] === "true" ||
								process.env.OPENCODE_NO_BROWSER === "1";

							const runOAuthFlow = async (): Promise<TokenResult> => {
								const { pkce, state, url } = await createAuthorizationFlow();
								console.log("\nOAuth URL:\n" + url + "\n");

										if (noBrowser) {
											const callbackInput = await promptOAuthCallbackValue(
												"Paste the full redirect URL (recommended). You can also paste code#state or just the code: ",
											);
											const parsed = parseAuthorizationInputForFlow(callbackInput, state);
											if (parsed.stateStatus === "mismatch") {
												console.log(
													"\nOAuth state mismatch. Paste the redirect URL from this login session (the one shown above).\n",
												);
												return { type: "failed" as const };
											}
											if (parsed.stateStatus === "missing") {
												console.log(
													"\nWarning: redirect state not provided. For best security, paste the full redirect URL.\n",
												);
											}
											if (!parsed.code) return { type: "failed" as const };
											return await exchangeAuthorizationCode(parsed.code, pkce.verifier, REDIRECT_URI);
										}

								let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;
								try {
									serverInfo = await startLocalOAuthServer({ state });
								} catch {
									serverInfo = null;
								}
								openBrowserUrl(url);

										if (!serverInfo || !serverInfo.ready) {
											serverInfo?.close();
											const callbackInput = await promptOAuthCallbackValue(
												"Paste the full redirect URL (recommended). You can also paste code#state or just the code: ",
											);
											const parsed = parseAuthorizationInputForFlow(callbackInput, state);
											if (parsed.stateStatus === "mismatch") {
												console.log(
													"\nOAuth state mismatch. Paste the redirect URL from this login session (the one shown above).\n",
												);
												return { type: "failed" as const };
											}
											if (parsed.stateStatus === "missing") {
												console.log(
													"\nWarning: redirect state not provided. For best security, paste the full redirect URL.\n",
												);
											}
											if (!parsed.code) return { type: "failed" as const };
											return await exchangeAuthorizationCode(parsed.code, pkce.verifier, REDIRECT_URI);
										}

								const result = await serverInfo.waitForCode(state);
								serverInfo.close();
								if (!result) return { type: "failed" as const };
								return await exchangeAuthorizationCode(result.code, pkce.verifier, REDIRECT_URI);
							};

						const authenticated: TokenOk[] = [];
						let startFresh = true;
						let existingStorage = repairedStorage ?? (await loadAccounts());
							if (existingStorage && existingStorage.accounts.length > 0) {
						const needsHydration = needsIdentityHydration(existingStorage.accounts);
								if (needsHydration) {
									try {
										console.log("\nRefreshing saved accounts to fill missing emails...\n");
										const manager = new AccountManager(undefined, existingStorage);
										await manager.hydrateMissingEmails();
										await manager.saveToDisk();
										existingStorage = await loadAccounts();
									} catch {
										// Best-effort; ignore.
									}
								}

						let existingLabels = (existingStorage?.accounts ?? []).map((a, index) => ({
							index,
							email: a.email,
							plan: a.plan,
							accountId: a.accountId,
							enabled: a.enabled,
						}));
						let mode = await promptLoginMode(existingLabels);
						while (mode === "manage") {
							let updatedStorage = existingStorage;
							while (updatedStorage) {
								const labels = (updatedStorage?.accounts ?? []).map((a, index) => ({
									index,
									email: a.email,
									plan: a.plan,
									accountId: a.accountId,
									enabled: a.enabled,
								}));
								const toggleIndex = await promptManageAccounts(labels);
								if (toggleIndex === null) break;
								const toggled = toggleAccountEnabled(updatedStorage, toggleIndex);
								if (toggled) {
								await saveAccounts(toggled, { preserveRefreshTokens: true });
									updatedStorage = toggled;
								}
							}
							existingStorage = await loadAccounts();
							existingLabels = (existingStorage?.accounts ?? []).map((a, index) => ({
								index,
								email: a.email,
								plan: a.plan,
								accountId: a.accountId,
								enabled: a.enabled,
							}));
							mode = await promptLoginMode(existingLabels);
						}
						startFresh = mode === "fresh";
					}

						if (startFresh) {
							await saveAccounts(
								{
									version: 3,
									accounts: [],
									activeIndex: 0,
									activeIndexByFamily: {},
								},
								{ replace: true },
							);
						}

							while (authenticated.length < MAX_ACCOUNTS) {
								console.log(`\n=== OpenAI OAuth (Account ${authenticated.length + 1}) ===`);
								const result = await runOAuthFlow();
								if (result.type !== "success") {
									if (authenticated.length === 0) {
										return {
											url: "",
											instructions: "Authentication failed.",
											method: "auto" as const,
											callback: async () => ({ type: "failed" as const }),
										};
									}
									break;
								}

							authenticated.push(result);
							await persistAccount(result);
							const email = sanitizeEmail(extractAccountEmail(result.idToken ?? result.access));
							const plan = extractAccountPlan(result.idToken ?? result.access);
							const label = formatAccountLabel(
								{ email, plan, accountId: extractAccountId(result.access) },
								authenticated.length - 1,
							);
							await showToast(`Authenticated: ${label}`, "success", quietMode);

								const currentStorage = await loadAccounts();
								const count = currentStorage?.accounts.length ?? authenticated.length;
								if (!(await promptAddAnotherAccount(count, MAX_ACCOUNTS))) break;
							}

							const primary = authenticated[0];
							if (!primary) {
								return {
									url: "",
									instructions: "Authentication cancelled",
									method: "auto" as const,
									callback: async () => ({ type: "failed" as const }),
								};
							}

							const finalStorage = await loadAccounts();
							const finalCount = finalStorage?.accounts.length ?? authenticated.length;
							debugAuth(
								`[OAuthAuthorize] OAuth flow completed with ${finalCount} accounts`,
							);
							return {
								url: "",
								instructions: `Multi-account setup complete (${finalCount} account(s)).\nStorage: ${getStoragePath()}`,
								method: "auto" as const,
								callback: async () => primary,
							};
						});
					}

					debugAuth("[OAuthAuthorize] Starting OAuth flow in TUI mode");
					const isHeadless = Boolean(
						process.env.SSH_CONNECTION ||
							process.env.SSH_CLIENT ||
							process.env.SSH_TTY ||
							process.env.OPENCODE_HEADLESS,
					);
					const useManualFlow = isHeadless || process.env.OPENCODE_NO_BROWSER === "1";
					const existingStorage = repairedStorage ?? (await loadAccounts());
					const existingCount = existingStorage?.accounts.length ?? 0;

					const { pkce, state, url } = await createAuthorizationFlow();
					let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;
					if (!useManualFlow) {
						try {
							serverInfo = await startLocalOAuthServer({ state });
						} catch {
							serverInfo = null;
						}
					}
					if (!useManualFlow) {
						openBrowserUrl(url);
					}

					if (serverInfo && serverInfo.ready) {
						return {
							url,
							instructions:
								"Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
							method: "auto" as const,
							callback: async () => {
								const result = await serverInfo.waitForCode(state);
								serverInfo.close();
								if (!result) return { type: "failed" as const };
								const tokens = await exchangeAuthorizationCode(
									result.code,
									pkce.verifier,
									REDIRECT_URI,
								);
									if (tokens?.type === "success") {
										await persistAccount(tokens);
										const email = sanitizeEmail(
											extractAccountEmail(tokens.idToken ?? tokens.access),
										);
										const plan = extractAccountPlan(tokens.idToken ?? tokens.access);
										const label = formatAccountLabel(
											{ email, plan, accountId: extractAccountId(tokens.access) },
											0,
										);
										const newTotal = existingCount + 1;
										const toastMessage =
											existingCount > 0
												? `Added account: ${label} - ${newTotal} total`
												: `Authenticated: ${label}`;
										await showToast(toastMessage, "success", quietMode);
									}
								return tokens?.type === "success"
									? tokens
									: { type: "failed" as const };
							},
						};
					}

					serverInfo?.close();

						return {
							url,
							instructions:
								"Visit the URL above, complete OAuth, then paste the full redirect URL (recommended) or the authorization code.",
							method: "code" as const,
							callback: async (input: string) => {
								const parsed = parseAuthorizationInputForFlow(input, state);
								if (parsed.stateStatus === "mismatch") {
									await showToast(
										"OAuth state mismatch. Paste the redirect URL from this login session.",
										"error",
										quietMode,
									);
									return { type: "failed" as const };
								}
											if (!parsed.code) return { type: "failed" as const };
											const tokens = await exchangeAuthorizationCode(
												parsed.code,
												pkce.verifier,
												REDIRECT_URI,
											);
									if (tokens?.type === "success") {
										await persistAccount(tokens);
										const email = sanitizeEmail(
											extractAccountEmail(tokens.idToken ?? tokens.access),
										);
										const plan = extractAccountPlan(tokens.idToken ?? tokens.access);
										const label = formatAccountLabel(
											{ email, plan, accountId: extractAccountId(tokens.access) },
											0,
										);
										const newTotal = existingCount + 1;
										const toastMessage =
											existingCount > 0
												? `Added account: ${label} - ${newTotal} total`
												: `Authenticated: ${label}`;
										await showToast(toastMessage, "success", quietMode);
									}
							return tokens?.type === "success"
								? tokens
								: { type: "failed" as const };
						},
					};
				},
				},
				{
					label: AUTH_LABELS.OAUTH_MANUAL,
					type: "oauth" as const,
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						return buildManualOAuthFlow(pkce, state, url, async (tokens) => {
							await persistAccount(tokens);
						});
					},
				},
				{
					label: AUTH_LABELS.API_KEY,
					type: "api" as const,
				},
			],
		},
		tool: {
		"openai-accounts": tool({
			description: "List all configured OpenAI OAuth accounts.",
			args: {},
			async execute() {
				configureStorageForCurrentCwd();
				const storage = await loadAccounts();
				const { scope, storagePath } = getStorageScope();
				const scopeLabel = scope === "project" ? "project" : "global";

				if (!storage || storage.accounts.length === 0) {
					return [
						`OpenAI Codex Status`,
						``,
						`  Scope: ${scopeLabel}`,
						`  Accounts: 0`,
						``,
						`Add accounts:`,
						`  opencode auth login`,
						``,
						`Storage: ${storagePath}`,
					].join("\n");
				}

				const activeIndex =
					typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex)
						? storage.activeIndex
						: 0;
				const now = Date.now();
				const enabledCount = storage.accounts.filter((a) => a.enabled !== false).length;
				const rateLimitedCount = storage.accounts.filter(
					(a) =>
						a.rateLimitResetTimes &&
						Object.values(a.rateLimitResetTimes).some(
							(t) => typeof t === "number" && t > now,
						),
				).length;

				const lines: string[] = [
					`OpenAI Codex Status`,
					``,
					`  Scope: ${scopeLabel}`,
					`  Accounts: ${enabledCount}/${storage.accounts.length} enabled`,
					...(rateLimitedCount > 0 ? [`  Rate-limited: ${rateLimitedCount}`] : []),
					``,
					` #  Label                                     Status`,
					`--- ----------------------------------------- ---------------------`,
				];
				storage.accounts.forEach((account, index) => {
					const label = formatAccountLabel(account, index);
					const statuses: string[] = [];
					if (index === activeIndex) statuses.push("active");
					if (account.enabled === false) statuses.push("disabled");
					const rateLimited =
						account.rateLimitResetTimes &&
						Object.values(account.rateLimitResetTimes).some(
							(t) => typeof t === "number" && t > now,
						);
					if (rateLimited) statuses.push("rate-limited");
					if (
						typeof account.coolingDownUntil === "number" &&
						account.coolingDownUntil > now
					) {
						statuses.push("cooldown");
					}
					lines.push(
						`${String(index + 1).padEnd(3)} ${label.padEnd(41)} ${
							statuses.length > 0 ? statuses.join(", ") : "ok"
						}`,
					);

					// Add Codex status details
					const codexLines = codexStatus.renderStatus(account);
					lines.push(...codexLines);
					lines.push(""); // Spacer between accounts
				});
				lines.push(`Storage: ${storagePath}`);
				return lines.join("\n");
			},
		}),
			"openai-accounts-switch": tool({
				description: "Switch active OpenAI account by index (1-based).",
				args: {
					index: tool.schema.number().describe("Account number (1-based)"),
				},
				async execute({ index }) {
					configureStorageForCurrentCwd();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						return "No OpenAI accounts configured. Run: opencode auth login";
					}
					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
						return `Invalid account number: ${index}\nValid range: 1-${storage.accounts.length}`;
					}
					storage.activeIndex = targetIndex;
					storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
					for (const family of MODEL_FAMILIES) {
						storage.activeIndexByFamily[family] = targetIndex;
					}
					const account = storage.accounts[targetIndex];
					if (account) {
						account.lastUsed = Date.now();
						account.lastSwitchReason = "rotation";
					}
					await saveAccounts(storage, { preserveRefreshTokens: true });
					if (cachedAccountManager) {
						cachedAccountManager.setActiveIndex(targetIndex);
						await cachedAccountManager.saveToDisk();
					}
					return `Switched to ${formatAccountLabel(account, targetIndex)}`;
				},
			}),
			"openai-accounts-toggle": tool({
				description: "Enable or disable an OpenAI account by index (1-based).",
				args: {
					index: tool.schema.number().describe("Account number (1-based)"),
				},
				async execute({ index }) {
					configureStorageForCurrentCwd();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) {
						return "No OpenAI accounts configured. Run: opencode auth login";
					}
					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= storage.accounts.length) {
						return `Invalid account number: ${index}\nValid range: 1-${storage.accounts.length}`;
					}
					const updated = toggleAccountEnabled(storage, targetIndex);
					if (!updated) {
						return `Failed to toggle account number: ${index}`;
					}
					await saveAccounts(updated, { preserveRefreshTokens: true });
					const account = updated.accounts[targetIndex];
					if (cachedAccountManager) {
						const live = cachedAccountManager.getAccountByIndex(targetIndex);
						if (live) live.enabled = account?.enabled !== false;
					}
					const enabled = account?.enabled !== false;
					const verb = enabled ? "Enabled" : "Disabled";
					return `${verb} ${formatAccountLabel(account, targetIndex)} (${targetIndex + 1}/${updated.accounts.length})`;
				},
			}),
		},
	};
};

export default OpenAIAuthPlugin;
