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
	type ManagedAccount,
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

		const activeIndex = stored?.activeIndex ?? 0;
		const storageToSave: AccountStorageV3 = {
			version: 3,
			accounts,
			activeIndex: Math.max(0, Math.min(activeIndex, accounts.length - 1)),
			activeIndexByFamily: stored?.activeIndexByFamily ?? {},
		};

		await saveAccounts(storageToSave);
	};

	return {
		auth: {
			provider: PROVIDER_ID,
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
					logDebug(`[${PLUGIN_NAME}] No OAuth accounts available (run opencode auth login)`);
					return {};
				}
				
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
										if (refreshed.type === "success") {
											if (refreshed.headers) {
												codexStatus
													.updateFromHeaders(live, Object.fromEntries(refreshed.headers.entries()))
													.catch(() => {});
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

				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
					async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;

						const transformation = await transformRequestForCodex(init, url, userConfig, codexMode);
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
									const snapshot = accountManager.getStorageSnapshot();
									if (repair.quarantined.length > 0) {
										const quarantinedTokens = new Set(repair.quarantined.map(a => a.refreshToken));
										const quarantineEntries = snapshot.accounts.filter(a => quarantinedTokens.has(a.refreshToken));
										await quarantineAccounts(snapshot, quarantineEntries, "legacy-auto-repair-failed");
										accountManager.removeAccountsByRefreshToken(quarantinedTokens);
									} else {
										await replaceAccountsFile(snapshot);
									}
									continue;
								}
							}
							
							const attempted = new Set<number>();

							while (attempted.size < Math.max(1, accountCount)) {
								const account = accountManager.getCurrentOrNextForFamily(modelFamily, model, accountSelectionStrategy, usePidOffset);
								if (!account || attempted.has(account.index)) break;
								attempted.add(account.index);

								let accountAuth = accountManager.toAuthDetails(account);
								const tokenExpired = !accountAuth.access || accountAuth.expires <= Date.now();
								
								const runRefresh = async (): Promise<TokenResult> => {
									const refreshed = await accountManager.refreshAccountWithFallback(account);
									if (refreshed.type === "success") {
										if (refreshed.headers) {
											codexStatus
												.updateFromHeaders(account, Object.fromEntries(refreshed.headers.entries()))
												.catch(() => {});
										}
										const refreshedAuth = {
											type: "oauth" as const,
											access: refreshed.access,
											refresh: refreshed.refresh,
											expires: refreshed.expires,
										};
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

								const headers = createCodexHeaders(requestInit, accountId, accountAuth.access, {
									model,
									promptCacheKey: transformation?.body?.prompt_cache_key,
								});

								let tokenConsumed = false;
								if (accountSelectionStrategy === "hybrid") {
									tokenConsumed = getTokenTracker().consume(account.index);
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
														if (data.type === "token_count" && data.rate_limits) {
															codexStatus.updateFromSnapshot(accountRef, data.rate_limits).catch(() => {});
														}
													} catch {}
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
													sseBuffer += chunk;
													const lines = sseBuffer.split("\n");
													sseBuffer = lines.pop() || "";
													for (const line of lines) processLine(line);
													controller.enqueue(value);
												},
												cancel() { reader.cancel(); }
											});
											
											res = new Response(transformStream, {
												status: res.status,
												statusText: res.statusText,
												headers: res.headers,
											});
										}

										const codexHeaders: Record<string, string> = {};
										try {
											res.headers.forEach((val, key) => {
												if (key.toLowerCase().startsWith("x-codex-")) codexHeaders[key.toLowerCase()] = val;
											});
										} catch {}

										if (Object.keys(codexHeaders).length > 0) {
											await codexStatus.updateFromHeaders(account, codexHeaders);
										}
									} catch (err) {
										if (tokenConsumed) getTokenTracker().refund(account.index);
										if (accountSelectionStrategy === "hybrid") getHealthTracker().recordFailure(account.index);
										throw err;
									}

									logRequest(LOG_STAGES.RESPONSE, {
										status: res.status,
										ok: res.ok,
										statusText: res.statusText,
										accountIndex: account.index,
										accountCount,
									});

									if (res.ok) {
										if (accountSelectionStrategy === "hybrid") getHealthTracker().recordSuccess(account.index);
										accountManager.markAccountUsed(account.index);
										return await handleSuccessResponse(res, isStreaming);
									}

									const handled = await handleErrorResponse(res);
									if (handled.status !== HTTP_STATUS.TOO_MANY_REQUESTS) {
										if (accountSelectionStrategy === "hybrid") getHealthTracker().recordFailure(account.index);
										return handled;
									}

									const retryAfterMs = parseRetryAfterMs(handled.headers);
									let responseText = "";
									try { responseText = await handled.clone().text(); } catch {}
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
									if (tokenConsumed) getTokenTracker().refund(account.index);
									if (accountSelectionStrategy === "hybrid") getHealthTracker().recordRateLimit(account.index);
									accountManager.markRateLimited(account, backoff.delayMs, modelFamily, model);

									if (decision.action === "wait") {
										if (!backoff.isDuplicate) {
											await accountManager.saveToDisk();
											await showToast(`Rate limited. Retrying in ${formatWaitTime(decision.delayMs)}...`, "warning", quietMode);
										}
										if (decision.delayMs > 0) await sleep(decision.delayMs);
										continue;
									}

									accountManager.markSwitched(account, "rate-limit", modelFamily);
									if (!backoff.isDuplicate) {
										await accountManager.saveToDisk();
										await showToast(`Rate limited. Switching accounts (retry in ${formatWaitTime(decision.delayMs)}).`, "warning", quietMode);
									}
									break;
								}
							}

							const waitMs = await accountManager.getMinWaitTimeForFamilyWithHydration(modelFamily, model);
							if (retryAllAccountsRateLimited && accountManager.getAccountCount() > 0 && waitMs > 0 && (retryAllAccountsMaxWaitMs === 0 || waitMs <= retryAllAccountsMaxWaitMs) && allRateLimitedRetries < retryAllAccountsMaxRetries) {
								allRateLimitedRetries += 1;
								await showToast(`All ${accountManager.getAccountCount()} account(s) are rate-limited. Waiting ${formatWaitTime(waitMs)}...`, "warning", quietMode);
								await sleep(waitMs);
								continue;
							}

							const now = Date.now();
							const accounts = accountManager.getAccountsSnapshot();
							const statusLines: string[] = [
								`All ${accountManager.getAccountCount()} account(s) are currently unavailable.`,
								`Next reset in approximately ${formatWaitTime(waitMs)}.`,
								"",
								"Account Status:",
							];

							for (let idx = 0; idx < accounts.length; idx++) {
								const acc = accounts[idx];
								if (!acc || acc.enabled === false) continue;
								const label = formatAccountLabel(acc, idx);
								const rateLimited = acc.rateLimitResetTimes && Object.values(acc.rateLimitResetTimes).some(t => typeof t === "number" && t > now);
								const coolingDown = typeof acc.coolingDownUntil === "number" && acc.coolingDownUntil > now;
								let status = "ok";
								if (rateLimited) status = "rate-limited";
								else if (coolingDown) status = "cooldown";
								statusLines.push(`- ${label} [${status}]`);
								const codexLines = await codexStatus.renderStatus(acc);
								statusLines.push(...codexLines.map(l => "  " + l.trim()));
							}

							statusLines.push("", "Run `opencode auth login` to add more accounts.");
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
						const isHeadless = Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.OPENCODE_HEADLESS);
						const useManualFlow = isHeadless || process.env.OPENCODE_NO_BROWSER === "1";
						const existingStorage = await loadAccounts();
						const existingCount = existingStorage?.accounts.length ?? 0;
						const { pkce, state, url } = await createAuthorizationFlow();
						let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;
						if (!useManualFlow) { try { serverInfo = await startLocalOAuthServer({ state }); } catch { serverInfo = null; } }
						if (!useManualFlow) openBrowserUrl(url);
						if (serverInfo && serverInfo.ready) {
							return {
								url,
								instructions: "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
								method: "auto" as const,
								callback: async () => {
									const result = await serverInfo.waitForCode(state);
									serverInfo.close();
									if (!result) return { type: "failed" as const };
									const tokens = await exchangeAuthorizationCode(result.code, pkce.verifier, REDIRECT_URI);
									if (tokens?.type === "success") {
										await persistAccount(tokens);
										const email = sanitizeEmail(extractAccountEmail(tokens.idToken ?? tokens.access));
										const plan = extractAccountPlan(tokens.idToken ?? tokens.access);
										const label = formatAccountLabel({ email, plan, accountId: extractAccountId(tokens.access) }, 0);
										const toastMessage = existingCount > 0 ? `Added account: ${label}` : `Authenticated: ${label}`;
										await showToast(toastMessage, "success", getQuietMode(loadPluginConfig()));
									}
									return tokens?.type === "success" ? tokens : { type: "failed" as const };
								},
							};
						}
						serverInfo?.close();
						return {
							url,
							instructions: "Visit the URL above, complete OAuth, then paste the full redirect URL (recommended) or the authorization code.",
							method: "code" as const,
							callback: async (input: string) => {
								const parsed = parseAuthorizationInputForFlow(input, state);
								if (parsed.stateStatus === "mismatch") return { type: "failed" as const };
								if (!parsed.code) return { type: "failed" as const };
								const tokens = await exchangeAuthorizationCode(parsed.code, pkce.verifier, REDIRECT_URI);
								if (tokens?.type === "success") {
									await persistAccount(tokens);
									const email = sanitizeEmail(extractAccountEmail(tokens.idToken ?? tokens.access));
									const plan = extractAccountPlan(tokens.idToken ?? tokens.access);
									const label = formatAccountLabel({ email, plan, accountId: extractAccountId(tokens.access) }, 0);
									const toastMessage = existingCount > 0 ? `Added account: ${label}` : `Authenticated: ${label}`;
									await showToast(toastMessage, "success", getQuietMode(loadPluginConfig()));
								}
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
					const accountManager = await AccountManager.loadFromDisk();
					await accountManager.hydrateMissingEmails();
					await accountManager.saveToDisk();
					const accounts = accountManager.getAccountsSnapshot();
					const activeIndex = accountManager.getActiveIndexForFamily("gpt-5.2");
					const { scope, storagePath } = getStorageScope();
					const scopeLabel = scope === "project" ? "project" : "global";
					if (accounts.length === 0) {
						return [`OpenAI Codex Status`, ``, `  Scope: ${scopeLabel}`, `  Accounts: 0`, ``, `Add accounts:`, `  opencode auth login`, ``, `Storage: ${storagePath}`].join("\n");
					}
					await Promise.all(accounts.map(async (acc, index) => {
						if (acc.enabled === false) return;
						const live = accountManager.getAccountByIndex(index);
						if (live) {
							const refreshResult = await accountManager.refreshAccountWithFallback(live);
							if (refreshResult.type === "success") await codexStatus.fetchFromBackend(live, refreshResult.access);
						}
					}));
					const now = Date.now();
					const enabledCount = accounts.filter(a => a.enabled !== false).length;
					const rateLimitedCount = accounts.filter(a => a.rateLimitResetTimes && Object.values(a.rateLimitResetTimes).some(t => typeof t === "number" && t > now)).length;
					const lines: string[] = [`OpenAI Codex Status`, ``, `  Scope: ${scopeLabel}`, `  Accounts: ${enabledCount}/${accounts.length} enabled`, ...(rateLimitedCount > 0 ? [`  Rate-limited: ${rateLimitedCount}`] : []), ``, ` #   Account                                   Plan       Status`, `---  ----------------------------------------- ---------- ---------------------` ];
					for (let index = 0; index < accounts.length; index++) {
						const account = accounts[index];
						if (!account) continue;
						const email = account.email || "unknown";
						const plan = account.plan || "Free";
						const statuses: string[] = [];
						if (index === activeIndex) statuses.push("active");
						if (account.enabled === false) statuses.push("disabled");
						const rateLimited = account.rateLimitResetTimes && Object.values(account.rateLimitResetTimes).some(t => typeof t === "number" && t > now);
						if (rateLimited) statuses.push("rate-limited");
						if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) statuses.push("cooldown");
						lines.push(`${String(index + 1).padStart(2)}   ${email.padEnd(41)} ${plan.padEnd(10)} ${statuses.length > 0 ? statuses.join(", ") : "ok"}`);
						const codexLines = await codexStatus.renderStatus(account);
						lines.push(...codexLines.map(l => "     " + l.trim()));
						lines.push("");
					}
					lines.push(`Storage: ${storagePath}`);
					return lines.join("\n");
				},
			}),
			"status-codex": tool({
				description: "Show a compact inline status of all OpenAI Codex accounts.",
				args: {},
				async execute() {
					configureStorageForCurrentCwd();
					const accountManager = await AccountManager.loadFromDisk();
					await accountManager.hydrateMissingEmails();
					await accountManager.saveToDisk();
					const accounts = accountManager.getAccountsSnapshot();
					if (accounts.length === 0) return "No OpenAI accounts configured. Run `opencode auth login`.";
					const activeIndex = accountManager.getActiveIndexForFamily("gpt-5.2");
					await Promise.all(accounts.map(async (acc, index) => {
						if (acc.enabled === false) return;
						const live = accountManager.getAccountByIndex(index);
						if (live) {
							const refreshResult = await accountManager.refreshAccountWithFallback(live);
							if (refreshResult.type === "success") await codexStatus.fetchFromBackend(live, refreshResult.access);
						}
					}));
					const now = Date.now();
					const lines: string[] = ["OpenAI Codex Accounts Status:"];
					for (let index = 0; index < accounts.length; index++) {
						const account = accounts[index];
						if (!account) continue;
						const email = account.email || "unknown";
						const plan = account.plan || "Free";
						const rateLimited = account.rateLimitResetTimes && Object.values(account.rateLimitResetTimes).some(t => typeof t === "number" && t > now);
						const coolingDown = typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now;
						const disabled = account.enabled === false;
						let status = "ok";
						if (disabled) status = "disabled";
						else if (rateLimited) status = "rate-limited";
						else if (coolingDown) status = "cooldown";
						lines.push(`${index === activeIndex ? "*" : "-"} ${email.padEnd(41)} (${plan.padEnd(10)}) [${status}]`);
						const codexLines = await codexStatus.renderStatus(account);
						lines.push(...codexLines.map(l => "  " + l.trim()));
					}
					return lines.join("\n");
				},
			}),
			"openai-accounts-switch": tool({
				description: "Switch active OpenAI account by index (1-based).",
				args: { index: tool.schema.number().describe("Account number (1-based)") },
				async execute({ index }) {
					configureStorageForCurrentCwd();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) return "No OpenAI accounts configured. Run: opencode auth login";
					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= storage.accounts.length) return `Invalid account number: ${index}\nValid range: 1-${storage.accounts.length}`;
					storage.activeIndex = targetIndex;
					storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
					for (const family of MODEL_FAMILIES) storage.activeIndexByFamily[family] = targetIndex;
					const account = storage.accounts[targetIndex];
					if (account) { account.lastUsed = Date.now(); account.lastSwitchReason = "rotation"; }
					await saveAccounts(storage, { preserveRefreshTokens: true });
					if (cachedAccountManager) { cachedAccountManager.setActiveIndex(targetIndex); await cachedAccountManager.saveToDisk(); }
					return `Switched to ${formatAccountLabel(account, targetIndex)}`;
				},
			}),
			"openai-accounts-toggle": tool({
				description: "Enable or disable an OpenAI account by index (1-based).",
				args: { index: tool.schema.number().describe("Account number (1-based)") },
				async execute({ index }) {
					configureStorageForCurrentCwd();
					const storage = await loadAccounts();
					if (!storage || storage.accounts.length === 0) return "No OpenAI accounts configured. Run: opencode auth login";
					const targetIndex = Math.floor((index ?? 0) - 1);
					if (targetIndex < 0 || targetIndex >= storage.accounts.length) return `Invalid account number: ${index}\nValid range: 1-${storage.accounts.length}`;
					const updated = toggleAccountEnabled(storage, targetIndex);
					if (!updated) return `Failed to toggle account number: ${index}`;
					await saveAccounts(updated, { preserveRefreshTokens: true });
					const account = updated.accounts[targetIndex];
					if (cachedAccountManager) {
						const live = cachedAccountManager.getAccountByIndex(targetIndex);
						if (live) { live.enabled = account?.enabled !== false; await cachedAccountManager.saveToDisk(); }
					}
					return `${account?.enabled !== false ? "Enabled" : "Disabled"} ${formatAccountLabel(account, targetIndex)}`;
				},
			}),
		},
	};
};

export default OpenAIAuthPlugin;
