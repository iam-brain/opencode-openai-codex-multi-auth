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
	sanitizeEmail,
	type ManagedAccount,
} from "./lib/accounts.js";
import {
	promptAddAnotherAccount,
} from "./lib/cli.js";
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
	toggleAccountEnabled,
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
import { formatToastMessage } from "./lib/formatting.js";

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
		} catch { }
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

	const persistAccount = async (token: Extract<TokenSuccess, { type: "success" }>): Promise<void> => {
		const now = Date.now();
		const stored = await loadAccounts();
		const accounts = stored?.accounts ? [...stored.accounts] : [];
		const accountId = extractAccountId(token.access);
		const email = sanitizeEmail(extractAccountEmail(token.idToken ?? token.access));
		const plan = extractAccountPlan(token.idToken ?? token.access);
		const existingIndex = findAccountMatchIndex(accounts, { accountId, plan, email });

		if (existingIndex === -1) {
			accounts.push({ refreshToken: token.refresh, accountId, email, plan, enabled: true, addedAt: now, lastUsed: now });
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
		await saveAccounts({
			version: 3,
			accounts,
			activeIndex: Math.max(0, Math.min(stored?.activeIndex ?? 0, accounts.length - 1)),
			activeIndexByFamily: stored?.activeIndexByFamily ?? {},
		});
	};

	return {
		auth: {
			provider: PROVIDER_ID,
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();
				if (!isOAuthAuth(auth)) return {};

				const pluginConfig = loadPluginConfig();
				configureStorageForPluginConfig(pluginConfig, process.cwd());
				const quietMode = getQuietMode(pluginConfig);
				const toastDebounceMs = getRateLimitToastDebounceMs(pluginConfig);
				const accountManager = await AccountManager.loadFromDisk(auth);
				cachedAccountManager = accountManager;

				if (accountManager.getAccountCount() === 0) {
					await autoQuarantineCorruptAccountsFile();
					return {};
				}

				const providerConfig = provider as { options?: Record<string, unknown>; models?: UserConfig["models"] } | undefined;
				const userConfig: UserConfig = { global: providerConfig?.options || {}, models: providerConfig?.models || {} };

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

				const proactiveRefreshQueue = proactiveRefreshEnabled
					? new ProactiveRefreshQueue({ bufferMs: tokenRefreshSkewMs, intervalMs: 250 })
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
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;
						const transformation = await transformRequestForCodex(init, url, userConfig, getCodexMode(pluginConfig));
						const requestInit = transformation?.updatedInit ?? init;
						const model = transformation?.body.model;
						const modelFamily: ModelFamily = model ? getModelFamily(model) : "gpt-5.1";
						const usePidOffset = pidOffsetEnabled && accountManager.getAccountCount() > 1;

						const abortSignal = requestInit?.signal ?? init?.signal ?? null;
						const sleep = (ms: number): Promise<void> =>
							new Promise((resolve, reject) => {
								if (abortSignal?.aborted) return reject(new Error("Aborted"));
								const timeout = setTimeout(() => { cleanup(); resolve(); }, ms);
								const onAbort = () => { cleanup(); reject(new Error("Aborted")); };
								const cleanup = () => { clearTimeout(timeout); abortSignal?.removeEventListener("abort", onAbort); };
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
									const storageSnapshot = accountManager.getStorageSnapshot();
									if (repair.quarantined.length > 0) {
										const quarantinedTokens = new Set(repair.quarantined.map(a => a.refreshToken));
										const quarantineEntries = storageSnapshot.accounts.filter(a => quarantinedTokens.has(a.refreshToken));
										await quarantineAccounts(storageSnapshot, quarantineEntries, "legacy-auto-repair-failed");
										accountManager.removeAccountsByRefreshToken(quarantinedTokens);
									} else {
										await replaceAccountsFile(storageSnapshot);
									}
									continue;
								}
							}

							const attempted = new Set<number>();
							while (attempted.size < Math.max(1, accountCount)) {
								const account = accountManager.getCurrentOrNextForFamily(modelFamily, model, getAccountSelectionStrategy(pluginConfig), usePidOffset);
								if (!account || attempted.has(account.index)) break;
								attempted.add(account.index);

								let accountAuth = accountManager.toAuthDetails(account);
								const tokenExpired = !accountAuth.access || accountAuth.expires <= Date.now();

								const runRefresh = async (): Promise<TokenResult> => {
									const refreshed = await accountManager.refreshAccountWithFallback(account);
									if (refreshed.type === "success") {
										if (refreshed.headers) codexStatus.updateFromHeaders(account, Object.fromEntries(refreshed.headers.entries())).catch(() => { });
										const refreshedAuth = { type: "oauth" as const, access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
										accountManager.updateFromAuth(account, refreshedAuth);
										await accountManager.saveToDisk();
										await client.auth.set({ path: { id: PROVIDER_ID }, body: refreshedAuth });
									}
									return refreshed;
								};

								if (shouldRefreshToken(accountAuth, tokenRefreshSkewMs)) {
									if (proactiveRefreshQueue && !tokenExpired) {
										void proactiveRefreshQueue.enqueue({ key: `account-${account.index}`, expires: accountAuth.expires, refresh: runRefresh });
									} else {
										const refreshed = await runRefresh();
										if (refreshed.type !== "success") {
											accountManager.markAccountCoolingDown(account, AUTH_FAILURE_COOLDOWN_MS, "auth-failure");
											await accountManager.saveToDisk();
											continue;
										}
										accountAuth = { type: "oauth", access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
									}
								}

								const accountId = account.accountId ?? extractAccountId(accountAuth.access);
								if (!accountId) {
									accountManager.markAccountCoolingDown(account, AUTH_FAILURE_COOLDOWN_MS, "auth-failure");
									await accountManager.saveToDisk();
									continue;
								}
								account.accountId = accountId;

								const headers = createCodexHeaders(requestInit, accountId, accountAuth.access, { model, promptCacheKey: transformation?.body?.prompt_cache_key });

								let tokenConsumed = false;
								if (getAccountSelectionStrategy(pluginConfig) === "hybrid") {
									tokenConsumed = getTokenTracker().consume(account);
									if (!tokenConsumed) continue;
								}

								while (true) {
									let res: Response;
									try {
										res = await fetch(url, { ...requestInit, headers });
										if (res.body) {
											const accountRef = account;
											const originalBody = res.body;
											const reader = originalBody.getReader();
											const decoder = new TextDecoder();
											let sseBuffer = "";
											const processLine = (line: string) => {
												if (line.startsWith("data: ")) {
													try {
														const data = JSON.parse(line.substring(6));
														if (data.type === "token_count" && data.rate_limits) codexStatus.updateFromSnapshot(accountRef, data.rate_limits).catch(() => { });
													} catch { }
												}
											};
											const transformStream = new ReadableStream({
												async pull(controller) {
													const { done, value } = await reader.read();
													if (done) {
														if (sseBuffer.trim()) {
															const lines = sseBuffer.split("\n");
															for (const line of lines) processLine(line);
														}
														controller.close();
														return;
													}
													const chunk = decoder.decode(value, { stream: true });
													if (sseBuffer.length + chunk.length > 1024 * 1024) sseBuffer = chunk; else sseBuffer += chunk;
													const lines = sseBuffer.split("\n");
													sseBuffer = lines.pop() || "";
													for (const line of lines) processLine(line);
													controller.enqueue(value);
												},
												cancel() { reader.cancel(); }
											});
											res = new Response(transformStream, { status: res.status, statusText: res.statusText, headers: res.headers });
										}
										const codexHeaders: Record<string, string> = {};
										try { res.headers.forEach((val, key) => { if (key.toLowerCase().startsWith("x-codex-")) codexHeaders[key.toLowerCase()] = val; }); } catch { }
										if (Object.keys(codexHeaders).length > 0) await codexStatus.updateFromHeaders(account, codexHeaders);
							} catch (err) {
									if (tokenConsumed) getTokenTracker().refund(account);
									if (getAccountSelectionStrategy(pluginConfig) === "hybrid") getHealthTracker().recordFailure(account);
									throw err;
								}

								if (res.ok) {
									if (getAccountSelectionStrategy(pluginConfig) === "hybrid") getHealthTracker().recordSuccess(account);
									accountManager.markAccountUsed(account.index);
									return await handleSuccessResponse(res, isStreaming);
								}

								// Handle Unauthorized (401) - potentially a stale token due to parallel rotation
								if (res.status === HTTP_STATUS.UNAUTHORIZED) {
									debugAuth(`[Fetch] 401 Unauthorized for ${account.email}. Attempting recovery...`);
									const recovery = await runRefresh();
									if (recovery.type === "success") {
										// Update headers with new token and retry the loop
										accountAuth = { type: "oauth", access: recovery.access, refresh: recovery.refresh, expires: recovery.expires };
										const newHeaders = createCodexHeaders(requestInit, accountId, accountAuth.access, { model, promptCacheKey: transformation?.body?.prompt_cache_key });
										// Update headers for the retry
										newHeaders.forEach((v, k) => headers.set(k, v));
										continue;
									}
									// If refresh/reload failed, mark as cooling down and try next account
									accountManager.markAccountCoolingDown(account, AUTH_FAILURE_COOLDOWN_MS, "auth-failure");
									await accountManager.saveToDisk();
									break;
								}

								const handled = await handleErrorResponse(res);
								if (handled.status !== HTTP_STATUS.TOO_MANY_REQUESTS) {
									if (getAccountSelectionStrategy(pluginConfig) === "hybrid") getHealthTracker().recordFailure(account);
									return handled;
								}

									const retryAfterMs = parseRetryAfterMs(handled.headers);
									let responseText = "";
									try { responseText = await handled.clone().text(); } catch { }
									const reason = parseRateLimitReason(handled.status, responseText);
									const backoff = rateLimitTracker.getBackoff(`${account.index}:${modelFamily}:${model ?? ""}`, reason, retryAfterMs);
									const decision = decideRateLimitAction({ schedulingMode: getSchedulingMode(pluginConfig), accountCount, maxCacheFirstWaitMs: Math.max(0, Math.floor(getMaxCacheFirstWaitSeconds(pluginConfig) * 1000)), switchOnFirstRateLimit: getSwitchOnFirstRateLimit(pluginConfig), shortRetryThresholdMs: RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS, backoff });
									if (tokenConsumed) getTokenTracker().refund(account);
									if (getAccountSelectionStrategy(pluginConfig) === "hybrid") getHealthTracker().recordRateLimit(account);
									accountManager.markRateLimited(account, backoff.delayMs, modelFamily, model);

									if (decision.action === "wait") {
										if (!backoff.isDuplicate) await accountManager.saveToDisk();
										if (decision.delayMs > 0) await sleep(decision.delayMs);
										continue;
									}
									accountManager.markSwitched(account, "rate-limit", modelFamily);
									if (!quietMode && accountManager.shouldShowAccountToast(account.index, toastDebounceMs)) {
										accountManager.markToastShown(account.index);
										void showToast(`Rate limited - switching account`, "warning", false);
									}
									if (!backoff.isDuplicate) await accountManager.saveToDisk();
									break;
								}
							}

							const waitMs = await accountManager.getMinWaitTimeForFamilyWithHydration(modelFamily, model);
							if (getRetryAllAccountsRateLimited(pluginConfig) && accountManager.getAccountCount() > 0 && waitMs > 0 && (getRetryAllAccountsMaxWaitMs(pluginConfig) === 0 || waitMs <= getRetryAllAccountsMaxWaitMs(pluginConfig)) && allRateLimitedRetries < getRetryAllAccountsMaxRetries(pluginConfig)) {
								allRateLimitedRetries += 1;
								await sleep(waitMs);
								continue;
							}

							const statusLines: string[] = [`All ${accountManager.getAccountCount()} account(s) unavailable.`, `Next reset in approximately ${formatWaitTime(waitMs)}.`, "", "Account Status:"];
							const accs = accountManager.getAccountsSnapshot();
							for (let idx = 0; idx < accs.length; idx++) {
								const acc = accs[idx];
								if (!acc || acc.enabled === false) continue;
								let status = "ok";
								const isRateLimited = acc.rateLimitResetTimes && Object.values(acc.rateLimitResetTimes).some(t => typeof t === "number" && t > Date.now());
								if (isRateLimited) status = "rate-limited";
								else if (typeof acc.coolingDownUntil === "number" && acc.coolingDownUntil > Date.now()) status = "cooldown";
								statusLines.push(`- ${formatAccountLabel(acc, idx)} [${status}]`);
								const codexLines = await codexStatus.renderStatus(acc);
								statusLines.push(...codexLines.map(l => "  " + l.trim()));
							}
							return new Response(JSON.stringify({ error: { message: statusLines.join("\n") } }), { status: 429, headers: { "content-type": "application/json; charset=utf-8" } });
						}
					},
				};
			},
			methods: [
				{
					label: AUTH_LABELS.OAUTH,
					type: "oauth" as const,
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						let serverInfo = null;
						if (!(process.env.OPENCODE_NO_BROWSER === "1")) { try { serverInfo = await startLocalOAuthServer({ state }); openBrowserUrl(url); } catch { serverInfo = null; } }
						if (serverInfo && serverInfo.ready) {
							return {
								url, method: "auto" as const, instructions: "Sign in in your browser.",
								callback: async () => {
									const result = await serverInfo.waitForCode(state);
									serverInfo.close();
									if (!result) return { type: "failed" as const };
									const tokens = await exchangeAuthorizationCode(result.code, pkce.verifier, REDIRECT_URI);
									if (tokens?.type === "success") await persistAccount(tokens);
									return tokens?.type === "success" ? tokens : { type: "failed" as const };
								},
							};
						}
						return {
							url, method: "code" as const, instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
							callback: async (input: string) => {
								const parsed = parseAuthorizationInputForFlow(input, state);
								if (parsed.stateStatus === "mismatch") return { type: "failed" as const };
								if (!parsed.code) return { type: "failed" as const };
								const tokens = await exchangeAuthorizationCode(parsed.code, pkce.verifier, REDIRECT_URI);
								if (tokens?.type === "success") await persistAccount(tokens);
								return tokens?.type === "success" ? tokens : { type: "failed" as const };
							},
						};
					},
				},
				{
					label: AUTH_LABELS.OAUTH_MANUAL,
					type: "oauth" as const,
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						return buildManualOAuthFlow(pkce, state, url, async (tokens) => { await persistAccount(tokens); });
					},
				},
				{ label: AUTH_LABELS.API_KEY, type: "api" as const },
			],
		},
		config: async (cfg) => {
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

			cfg.experimental = cfg.experimental || {};
			cfg.experimental.primary_tools = cfg.experimental.primary_tools || [];
			for (const t of ["codex-status", "codex-switch-accounts", "codex-toggle-account"]) {
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
				// NOTE: Do NOT call hydrateMissingEmails() here - status should be read-only
				// and not trigger token refreshes that could fail when rate-limited
				const accounts = accountManager.getAccountsSnapshot();
				const { scope, storagePath } = getStorageScope();
				if (accounts.length === 0) return [`OpenAI Codex Status`, ``, `  Scope: ${scope}`, `  Accounts: 0`, ``, `Add accounts:`, `  opencode auth login`, ``, `Storage: ${storagePath}`].join("\n");

				// Fetch status from backend - requires access token, so we may need to refresh
				// This is best-effort: if refresh fails (e.g., rate-limited), we fall back to cached data
				await Promise.all(accounts.map(async (acc, index) => {
					if (acc.enabled === false) return;
					const live = accountManager.getAccountByIndex(index);
					if (!live) return;

					try {
						let auth = accountManager.toAuthDetails(live);
						const hasValidToken = auth.access && auth.expires > Date.now();

						// If no valid access token in memory, try to refresh (best effort)
						if (!hasValidToken) {
							const refreshResult = await accountManager.refreshAccountWithFallback(live);
							if (refreshResult.type === "success") {
								auth = { type: "oauth", access: refreshResult.access, refresh: refreshResult.refresh, expires: refreshResult.expires };
								// Update in-memory state AND save to disk (rotation occurred)
								accountManager.updateFromAuth(live, auth);
								await accountManager.saveToDisk();
							}
						}

						// If we now have a valid token, fetch status
						if (auth.access && auth.expires > Date.now()) {
							await codexStatus.fetchFromBackend(live, auth.access);
						}
					} catch {
						// Silently fall back to cached snapshot if anything fails
					}
				}));

					const now = Date.now();
					const enabledCount = accounts.filter(a => a.enabled !== false).length;
					const activeIndex = accountManager.getActiveIndexForFamily("gpt-5.2");
					const lines: string[] = [`OpenAI Codex Status`, ``, `  Scope: ${scope}`, `  Accounts: ${enabledCount}/${accounts.length} enabled`, ``, `  #   Account                                   Plan       Status`, ` ---  ----------------------------------------- ---------- ---------------------` ];
					for (let index = 0; index < accounts.length; index++) {
						const account = accounts[index];
						if (!account) continue;
						const statuses: string[] = [];
						if (index === activeIndex) statuses.push("active");
						if (account.enabled === false) statuses.push("disabled");
						const isRateLimited = account.rateLimitResetTimes && Object.values(account.rateLimitResetTimes).some(t => typeof t === "number" && t > now);
						if (isRateLimited) statuses.push("rate-limited");
						if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) statuses.push("cooldown");
						lines.push(`  ${String(index + 1).padStart(2)}   ${(account.email || "unknown").padEnd(41)} ${(account.plan || "Free").padEnd(10)} ${statuses.length > 0 ? statuses.join(", ") : "ok"}`);
						const codexLines = await codexStatus.renderStatus(account);
						lines.push(...codexLines.map(l => "       " + l.trim()));
					}
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
		},
	};
};

export default OpenAIAuthPlugin;
