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
	parseAuthorizationInput,
	REDIRECT_URI,
	refreshAccessToken,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import {
	getAccountSelectionStrategy,
	getCodexMode,
	getPidOffsetEnabled,
	getQuietMode,
	getRateLimitToastDebounceMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
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
	formatAccountLabel,
	formatWaitTime,
	isOAuthAuth,
	sanitizeEmail,
} from "./lib/accounts.js";
import { promptAddAnotherAccount, promptLoginMode } from "./lib/cli.js";
import { getStoragePath, loadAccounts, saveAccounts } from "./lib/storage.js";
import { getModelFamily, MODEL_FAMILIES, type ModelFamily } from "./lib/prompts/codex.js";
import type { OAuthAuthDetails, TokenResult, TokenSuccess, UserConfig } from "./lib/types.js";
import { getHealthTracker, getTokenTracker } from "./lib/rotation.js";

const RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS = 5_000;
const AUTH_FAILURE_COOLDOWN_MS = 60_000;
const MAX_ACCOUNTS = 10;

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

	const showToast = async (
		message: string,
		variant: "info" | "success" | "warning" | "error" = "info",
		quietMode: boolean = false,
	): Promise<void> => {
		if (quietMode) return;
		try {
			await client.tui.showToast({ body: { message, variant } });
		} catch {
			// ignore (non-TUI contexts)
		}
	};

	const buildManualOAuthFlow = (
		pkce: { verifier: string },
		url: string,
		onSuccess?: (tokens: TokenOk) => Promise<void>,
	) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInput(input);
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
		const now = Date.now();
		const stored = await loadAccounts();
		const accounts = stored?.accounts ? [...stored.accounts] : [];
		const accountId = extractAccountId(token.access);
		const email = sanitizeEmail(extractAccountEmail(token.access));

		const matchIndex =
			(accountId ? accounts.findIndex((a) => a.accountId === accountId) : -1) ?? -1;
		const matchIndexByEmail = email ? accounts.findIndex((a) => a.email === email) : -1;
		const matchIndexByToken = accounts.findIndex((a) => a.refreshToken === token.refresh);
		const existingIndex =
			matchIndex >= 0
				? matchIndex
				: matchIndexByEmail >= 0
					? matchIndexByEmail
					: matchIndexByToken;

		if (existingIndex === -1) {
			accounts.push({
				refreshToken: token.refresh,
				accountId,
				email,
				addedAt: now,
				lastUsed: now,
			});
		} else {
			const existing = accounts[existingIndex];
			if (existing) {
				existing.refreshToken = token.refresh;
				existing.accountId = accountId ?? existing.accountId;
				existing.email = email ?? existing.email;
				existing.lastUsed = now;
			}
		}

		const activeIndex = stored?.activeIndex ?? 0;
		await saveAccounts({
			version: 3,
			accounts,
			activeIndex: Math.max(0, Math.min(activeIndex, accounts.length - 1)),
			activeIndexByFamily: stored?.activeIndexByFamily ?? {},
		});
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

				const accountManager = await AccountManager.loadFromDisk(auth);
				cachedAccountManager = accountManager;
				if (accountManager.getAccountCount() === 0) {
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

				const pluginConfig = loadPluginConfig();
				const codexMode = getCodexMode(pluginConfig);
				const accountSelectionStrategy = getAccountSelectionStrategy(pluginConfig);
				const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
				const quietMode = getQuietMode(pluginConfig);
				const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
				const toastDebounceMs = getRateLimitToastDebounceMs(pluginConfig);
				const retryAllAccountsRateLimited = getRetryAllAccountsRateLimited(pluginConfig);
				const retryAllAccountsMaxWaitMs = getRetryAllAccountsMaxWaitMs(pluginConfig);
				const retryAllAccountsMaxRetries = getRetryAllAccountsMaxRetries(pluginConfig);

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

						while (true) {
							const accountCount = accountManager.getAccountCount();
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
								if (shouldRefreshToken(accountAuth, tokenRefreshSkewMs)) {
									const refreshed = await refreshAccessToken(account.refreshToken);
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
									accountManager.updateFromAuth(account, accountAuth);
									await accountManager.saveToDisk();

									// Keep OpenCode's stored auth aligned with the last-used account.
									await client.auth.set({
										path: { id: PROVIDER_ID },
										body: accountAuth,
									});
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
										return await handleSuccessResponse(res, isStreaming);
									}

									const handled = await handleErrorResponse(res);
									if (handled.status !== HTTP_STATUS.TOO_MANY_REQUESTS) {
										if (accountSelectionStrategy === "hybrid") {
											getHealthTracker().recordFailure(account.index);
										}
										return handled;
									}

									const retryAfterMs = parseRetryAfterMs(handled.headers) ?? 60_000;
									if (tokenConsumed) {
										getTokenTracker().refund(account.index);
										tokenConsumed = false;
									}
									if (accountSelectionStrategy === "hybrid") {
										getHealthTracker().recordRateLimit(account.index);
									}
									if (retryAfterMs <= RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS) {
										await showToast(
											`Rate limited. Retrying in ${formatWaitTime(retryAfterMs)}...`,
											"warning",
											quietMode,
										);
										await sleep(retryAfterMs);
										continue;
									}

									accountManager.markRateLimited(account, retryAfterMs, modelFamily, model);
									accountManager.markSwitched(account, "rate-limit", modelFamily);
									await accountManager.saveToDisk();
									await showToast(
										`Rate limited. Switching accounts (retry in ${formatWaitTime(retryAfterMs)}).`,
										"warning",
										quietMode,
									);
									break;
								}
							}

							const waitMs = accountManager.getMinWaitTimeForFamily(modelFamily, model);
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

							const storePath = getStoragePath();
							const waitLabel = waitMs > 0 ? formatWaitTime(waitMs) : "a bit";
							const message =
								accountManager.getAccountCount() === 0
									? "No OpenAI accounts configured. Run `opencode auth login`."
									: `All ${accountManager.getAccountCount()} account(s) are rate-limited. Try again in ${waitLabel} or add another account with \`opencode auth login\`. (Storage: ${storePath})`;
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
						const quietMode = getQuietMode(pluginConfig);
						const noBrowser =
							inputs?.noBrowser === "true" ||
							inputs?.["no-browser"] === "true" ||
							process.env.OPENCODE_NO_BROWSER === "1";

						const promptOAuthCallbackValue = async (message: string): Promise<string> => {
							const { createInterface } = await import("node:readline/promises");
							const { stdin, stdout } = await import("node:process");
							const rl = createInterface({ input: stdin, output: stdout });
							try {
								return (await rl.question(message)).trim();
							} finally {
								rl.close();
							}
						};

						const runOAuthFlow = async (): Promise<TokenResult> => {
							const { pkce, state, url } = await createAuthorizationFlow();
							console.log("\nOAuth URL:\n" + url + "\n");

							if (noBrowser) {
								const callbackInput = await promptOAuthCallbackValue(
									"Paste the redirect URL (or just the code) here: ",
								);
								const parsed = parseAuthorizationInput(callbackInput);
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
									"Paste the redirect URL (or just the code) here: ",
								);
								const parsed = parseAuthorizationInput(callbackInput);
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
						const existingStorage = await loadAccounts();
						if (existingStorage && existingStorage.accounts.length > 0) {
							const existingLabels = existingStorage.accounts.map((a, index) => ({
								index,
								email: a.email,
								accountId: a.accountId,
							}));
							const mode = await promptLoginMode(existingLabels);
							startFresh = mode === "fresh";
						}

						if (startFresh) {
							await saveAccounts({
								version: 3,
								accounts: [],
								activeIndex: 0,
								activeIndexByFamily: {},
							});
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
							await showToast(
								`Account ${authenticated.length} authenticated`,
								"success",
								quietMode,
							);

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
						return {
							url: "",
							instructions: `Multi-account setup complete (${finalCount} account(s)).\nStorage: ${getStoragePath()}`,
							method: "auto" as const,
							callback: async () => primary,
						};
					},
				},
					{
						label: AUTH_LABELS.OAUTH_MANUAL,
						type: "oauth" as const,
						authorize: async () => {
							const { pkce, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow(pkce, url, async (tokens) => {
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
					const storage = await loadAccounts();
					const storePath = getStoragePath();
					if (!storage || storage.accounts.length === 0) {
						return [
							"No OpenAI accounts configured.",
							"",
							"Add accounts:",
							"  opencode auth login",
							"",
							`Storage: ${storePath}`,
						].join("\n");
					}

					const activeIndex =
						typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex)
							? storage.activeIndex
							: 0;
					const now = Date.now();
					const lines: string[] = [
						`OpenAI Accounts (${storage.accounts.length}):`,
						"",
						" #  Label                                     Status",
						"----------------------------------------------- ---------------------",
					];
					storage.accounts.forEach((account, index) => {
						const label = formatAccountLabel(account, index);
						const statuses: string[] = [];
						if (index === activeIndex) statuses.push("active");
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
							`${String(index + 1).padEnd(3)} ${label.padEnd(40)} ${
								statuses.length > 0 ? statuses.join(", ") : "ok"
							}`,
						);
					});
					lines.push("", `Storage: ${storePath}`);
					return lines.join("\n");
				},
			}),
			"openai-accounts-switch": tool({
				description: "Switch active OpenAI account by index (1-based).",
				args: {
					index: tool.schema.number().describe("Account number (1-based)"),
				},
				async execute({ index }) {
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
					await saveAccounts(storage);
					if (cachedAccountManager) {
						cachedAccountManager.setActiveIndex(targetIndex);
						await cachedAccountManager.saveToDisk();
					}
					return `Switched to ${formatAccountLabel(account, targetIndex)}`;
				},
			}),
		},
	};
};

export default OpenAIAuthPlugin;
