import {
	AccountManager,
	extractAccountId,
	formatAccountLabel,
	formatWaitTime,
	type ManagedAccount,
} from "./accounts.js";
import {
	RateLimitTracker,
	decideRateLimitAction,
	parseRateLimitReason,
} from "./rate-limit.js";
import {
	type PluginConfig,
	type OAuthAuthDetails,
	type RequestBody,
	type TokenResult,
	type UserConfig,
} from "./types.js";
import {
	type TokenBucketTracker,
	type HealthScoreTracker,
} from "./rotation.js";
import { type CodexStatusManager } from "./codex-status.js";
import { type ProactiveRefreshQueue } from "./refresh-queue.js";
import {
	getAccountSelectionStrategy,
	getAuthDebugEnabled,
	getMaxCacheFirstWaitSeconds,
	getRateLimitDedupWindowMs,
	getRateLimitToastDebounceMs,
	getRequestJitterMaxMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
	getSchedulingMode,
	getSwitchOnFirstRateLimit,
} from "./config.js";
import {
	HTTP_STATUS,
	type ModelFamily,
	DEFAULT_MODEL_FAMILY,
} from "./constants.js";
import {
	createCodexHeaders,
	extractRequestUrl,
	rewriteUrlForCodex,
	transformRequestForCodex,
	handleErrorResponse,
	handleSuccessResponse,
} from "./request/fetch-helpers.js";
import { normalizeModel } from "./request/request-transformer.js";
import { getModelFamily } from "./prompts/codex.js";
import { logDebug, logWarn } from "./logger.js";
import { quarantineAccountsByRefreshToken } from "./storage.js";

const RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS = 5_000;
// Cooldown prevents spamming authentication requests for accounts with persistent failures.
const AUTH_FAILURE_COOLDOWN_MS = 60_000;

const debugAuth = (...args: unknown[]): void => {
	if (!getAuthDebugEnabled()) return;
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

function resolveSessionKey(body: RequestBody | undefined): string | null {
	const key = body?.prompt_cache_key;
	if (typeof key !== "string") return null;
	const trimmed = key.trim();
	return trimmed ? trimmed : null;
}

export interface FetchOrchestratorConfig {
	accountManager: AccountManager;
	pluginConfig: PluginConfig;
	rateLimitTracker: RateLimitTracker;
	healthTracker: HealthScoreTracker;
	tokenTracker: TokenBucketTracker;
	codexStatus: CodexStatusManager;
	proactiveRefreshQueue: ProactiveRefreshQueue | null;
	pidOffsetEnabled: boolean;
	tokenRefreshSkewMs: number;
	userConfig: UserConfig;
	quietMode?: boolean;
	onAuthUpdate: (auth: OAuthAuthDetails) => Promise<void>;
	showToast: (message: string, variant: "info" | "success" | "warning" | "error", quietMode: boolean) => Promise<void>;
}

export class FetchOrchestrator {
	private lastSessionKey: string | null = null;
	private readonly seenSessionKeys = new Set<string>();
	private lastAccountIndex: number | null = null;

	constructor(private config: FetchOrchestratorConfig) { }

	async execute(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		const {
			accountManager,
			pluginConfig,
			rateLimitTracker,
			healthTracker,
			tokenTracker,
			codexStatus,
			proactiveRefreshQueue,
			pidOffsetEnabled,
			tokenRefreshSkewMs,
			userConfig,
			quietMode = false,
			onAuthUpdate,
			showToast,
		} = this.config;

		const originalUrl = extractRequestUrl(input);
		const url = rewriteUrlForCodex(originalUrl);
		const authRetries = new Map<string, number>();

		let originalBody: any = {};
		if (init?.body && typeof init.body === "string") {
			try {
				originalBody = JSON.parse(init.body);
			} catch {
				originalBody = {};
			}
		}

		const isStreaming = originalBody.stream === true;
		const initialModel = normalizeModel(
			typeof originalBody?.model === "string" ? originalBody.model : undefined,
		);
		let transformation:
			| Awaited<ReturnType<typeof transformRequestForCodex>>
			| undefined;
		let requestInit = init;
		let model: string | undefined = initialModel;
		const modelFamily: ModelFamily = model
			? getModelFamily(model)
			: DEFAULT_MODEL_FAMILY;
		const usePidOffset = pidOffsetEnabled && accountManager.getAccountCount() > 1;
		const sessionBody =
			(originalBody && typeof originalBody === "object" ? originalBody : undefined) as
				| RequestBody
				| undefined;
		const sessionKey = resolveSessionKey(sessionBody);
		let sessionEvent: "new" | "switch" | null = null;
		if (sessionKey) {
			const hasSeen = this.seenSessionKeys.has(sessionKey);
			if (!hasSeen) {
				sessionEvent = "new";
				this.seenSessionKeys.add(sessionKey);
			} else if (this.lastSessionKey && this.lastSessionKey !== sessionKey) {
				sessionEvent = "switch";
			}
			this.lastSessionKey = sessionKey;
		}
		let sessionToastEmitted = false;

		const abortSignal = init?.signal ?? null;
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
			if (!autoRepairAttempted) {
				const legacyAccounts = accountManager.getLegacyAccounts();
				if (legacyAccounts.length > 0) {
					autoRepairAttempted = true;
					const repair = await accountManager.repairLegacyAccounts();
					const tokens = new Set(repair.quarantined.map((account) => account.refreshToken));
					if (tokens.size > 0) {
						await quarantineAccountsByRefreshToken(tokens, "legacy-repair");
						accountManager.removeAccountsByRefreshToken(tokens);
					} else if (repair.repaired.length > 0) {
						await accountManager.saveToDisk();
					}
					continue;
				}
			}

			const attempted = new Set<number>();
			while (attempted.size < Math.max(1, accountCount)) {
				const account = accountManager.getCurrentOrNextForFamily(modelFamily, model, getAccountSelectionStrategy(pluginConfig), usePidOffset);
				if (!account || attempted.has(account.index)) break;
				attempted.add(account.index);
				if (sessionEvent && !sessionToastEmitted) {
					const label = formatAccountLabel(account, account.index);
					const message = sessionEvent === "new"
						? `New chat: ${label}`
						: `Session switched: ${label}`;
					void showToast(message, "info", quietMode);
					sessionToastEmitted = true;
				}
				if (this.lastAccountIndex !== null && this.lastAccountIndex !== account.index) {
					const label = formatAccountLabel(account, account.index);
					void showToast(`Account switched: ${label}`, "info", quietMode);
				}
				this.lastAccountIndex = account.index;

				let accountAuth = accountManager.toAuthDetails(account);
				const tokenExpired = !accountAuth.access || accountAuth.expires <= Date.now();

				const runRefresh = async (): Promise<TokenResult> => {
					const refreshed = await accountManager.refreshAccountWithFallback(account);
					if (refreshed.type === "success") {
						if (refreshed.headers) codexStatus.updateFromHeaders(account, Object.fromEntries(refreshed.headers.entries())).catch(() => { });
						const refreshedAuth = { type: "oauth" as const, access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
						accountManager.updateFromAuth(account, refreshedAuth);
						await accountManager.saveToDisk();
						await onAuthUpdate(refreshedAuth);
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
					const label = formatAccountLabel(account, account.index);
					void showToast(`Auth failed: ${label}`, "error", quietMode);
					accountManager.markAccountCoolingDown(account, AUTH_FAILURE_COOLDOWN_MS, "auth-failure");
					await accountManager.saveToDisk();
					continue;
				}
				account.accountId = accountId;

				if (!transformation) {
					transformation = await transformRequestForCodex(init, url, userConfig, {
						accessToken: accountAuth.access,
						accountId,
					});
					requestInit = transformation?.updatedInit ?? init;
					model = transformation?.body.model ?? model;
				}

				const headers = createCodexHeaders(requestInit, accountId, accountAuth.access, { model, promptCacheKey: transformation?.body?.prompt_cache_key });

				let tokenConsumed = false;
				if (getAccountSelectionStrategy(pluginConfig) === "hybrid") {
					tokenConsumed = tokenTracker.consume(account);
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
									sseBuffer += chunk;
									const lines = sseBuffer.split("\n");
									sseBuffer = lines.pop() || "";
									for (const line of lines) processLine(line);

									// Memory safety: truncate buffer if it grows too large (e.g., missing newlines).
									if (sseBuffer.length > 1024 * 1024) {
										logWarn("[Fetch] SSE buffer exceeded 1MB. Truncating to avoid memory exhaustion.");
										sseBuffer = sseBuffer.slice(-1024 * 512); // Keep last 512KB to preserve partial line
									}
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
						if (tokenConsumed) tokenTracker.refund(account);
						if (getAccountSelectionStrategy(pluginConfig) === "hybrid") healthTracker.recordFailure(account);
						throw err;
					}

					if (res.ok) {
						if (getAccountSelectionStrategy(pluginConfig) === "hybrid") healthTracker.recordSuccess(account);
						accountManager.markAccountUsed(account.index);
						return await handleSuccessResponse(res, isStreaming);
					}

					if (res.status === HTTP_STATUS.UNAUTHORIZED) {
						debugAuth(`[Fetch] 401 Unauthorized for ${account.email}. Attempting recovery...`);

						const accountKey = account.email || `index:${account.index}`;
						const retryCount = authRetries.get(accountKey) ?? 0;
						if (retryCount < 1) {
							authRetries.set(accountKey, retryCount + 1);
							const recovery = await runRefresh();
							if (recovery.type === "success") {
								accountAuth = { type: "oauth", access: recovery.access, refresh: recovery.refresh, expires: recovery.expires };
								const newHeaders = createCodexHeaders(requestInit, accountId, accountAuth.access, { model, promptCacheKey: transformation?.body?.prompt_cache_key });
								newHeaders.forEach((v, k) => headers.set(k, v));
								continue;
							}
						} else {
							logWarn(`[Fetch] 401 Unauthorized retry limit reached for ${account.email}`);
						}

					const label = formatAccountLabel(account, account.index);
					void showToast(`Auth failed: ${label}`, "error", quietMode);
					accountManager.markAccountCoolingDown(account, AUTH_FAILURE_COOLDOWN_MS, "auth-failure");
					await accountManager.saveToDisk();
					break;
					}

					const errorResponse = await handleErrorResponse(res);
					if (errorResponse.status !== HTTP_STATUS.TOO_MANY_REQUESTS) {
						if (getAccountSelectionStrategy(pluginConfig) === "hybrid") healthTracker.recordFailure(account);
						return errorResponse;
					}

					const retryAfterMs = parseRetryAfterMs(errorResponse.headers);
					let responseText = "";
					try { responseText = await errorResponse.clone().text(); } catch { }
					const reason = parseRateLimitReason(errorResponse.status, responseText);
					const backoff = rateLimitTracker.getBackoff(`${account.index}:${modelFamily}:${model ?? ""}`, reason, retryAfterMs);
					const decision = decideRateLimitAction({ reason, schedulingMode: getSchedulingMode(pluginConfig), accountCount, maxCacheFirstWaitMs: Math.max(0, Math.floor(getMaxCacheFirstWaitSeconds(pluginConfig) * 1000)), switchOnFirstRateLimit: getSwitchOnFirstRateLimit(pluginConfig), shortRetryThresholdMs: RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS, backoff });
					if (tokenConsumed) tokenTracker.refund(account);
					if (getAccountSelectionStrategy(pluginConfig) === "hybrid") healthTracker.recordRateLimit(account);
					accountManager.markRateLimited(account, backoff.delayMs, modelFamily, model);

					if (decision.action === "wait") {
						if (!backoff.isDuplicate) await accountManager.saveToDisk();
						if (decision.delayMs > 0) await sleep(decision.delayMs);
						continue;
					}
					accountManager.markSwitched(account, "rate-limit", modelFamily);
					if (accountManager.shouldShowAccountToast(account.index, getRateLimitToastDebounceMs(pluginConfig))) {
						accountManager.markToastShown(account.index);
						void showToast(`Rate limited - switching account`, "warning", quietMode);
					}
					if (!backoff.isDuplicate) await accountManager.saveToDisk();
					break;
				}
			}

			const tokenWaitMs =
				getAccountSelectionStrategy(pluginConfig) === "hybrid"
					? accountManager.getMinTokenWaitMsForFamily(modelFamily, model, tokenTracker)
					: 0;
			if (tokenWaitMs && tokenWaitMs > 0) {
				await sleep(tokenWaitMs);
				continue;
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
	}
}
