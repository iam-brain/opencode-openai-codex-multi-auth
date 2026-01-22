import type { Auth } from "@opencode-ai/sdk";

import { decodeJWT, refreshAccessToken } from "./auth/auth.js";
import { JWT_CLAIM_PATH } from "./constants.js";
import type {
	AccountSelectionStrategy,
	AccountStorageV3,
	CooldownReason,
	OAuthAuthDetails,
	RateLimitStateV3,
} from "./types.js";
import { loadAccounts, saveAccounts } from "./storage.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";

export type BaseQuotaKey = ModelFamily;
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

function nowMs(): number {
	return Date.now();
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value < 0 ? 0 : Math.floor(value);
}

function getQuotaKey(family: ModelFamily, model?: string | null): QuotaKey {
	if (model) return `${family}:${model}`;
	return family;
}

export function extractAccountId(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const nested = decoded?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
	const accountId = nested?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
}

export function extractAccountEmail(accessToken?: string): string | undefined {
	if (!accessToken) return undefined;
	const decoded = decodeJWT(accessToken);
	const nested = decoded?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
	const candidate =
		(nested?.email as string | undefined) ??
		(nested?.chatgpt_user_email as string | undefined) ??
		(decoded?.email as string | undefined) ??
		(decoded?.preferred_username as string | undefined);
	if (typeof candidate === "string" && candidate.includes("@") && candidate.trim()) {
		return candidate;
	}
	return undefined;
}

export function sanitizeEmail(email: string | undefined): string | undefined {
	if (!email) return undefined;
	const trimmed = email.trim();
	if (!trimmed || !trimmed.includes("@")) return undefined;
	return trimmed.toLowerCase();
}

export function formatAccountLabel(
	account: { email?: string; accountId?: string } | undefined,
	index: number,
): string {
	const email = account?.email?.trim();
	const accountId = account?.accountId?.trim();
	const idSuffix = accountId
		? accountId.length > 6
			? accountId.slice(-6)
			: accountId
		: null;

	if (email && idSuffix) return `Account ${index + 1} (${email}, id:${idSuffix})`;
	if (email) return `Account ${index + 1} (${email})`;
	if (idSuffix) return `Account ${index + 1} (${idSuffix})`;
	return `Account ${index + 1}`;
}

export function formatWaitTime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export interface ManagedAccount {
	index: number;
	accountId?: string;
	email?: string;
	refreshToken: string;
	access?: string;
	expires?: number;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	rateLimitResetTimes: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

function clearExpiredRateLimits(account: ManagedAccount): void {
	const now = nowMs();
	for (const key of Object.keys(account.rateLimitResetTimes)) {
		const reset = account.rateLimitResetTimes[key];
		if (reset !== undefined && now >= reset) delete account.rateLimitResetTimes[key];
	}
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
	const reset = account.rateLimitResetTimes[key];
	return reset !== undefined && nowMs() < reset;
}

function isRateLimitedForFamily(
	account: ManagedAccount,
	family: ModelFamily,
	model?: string | null,
): boolean {
	clearExpiredRateLimits(account);

	if (model) {
		const modelKey = getQuotaKey(family, model);
		if (isRateLimitedForQuotaKey(account, modelKey)) return true;
	}

	const baseKey = getQuotaKey(family);
	return isRateLimitedForQuotaKey(account, baseKey);
}

export class AccountManager {
	private accounts: ManagedAccount[] = [];
	private cursor = 0;
	private currentAccountIndexByFamily: Record<ModelFamily, number> = {
		"gpt-5.2-codex": -1,
		"codex-max": -1,
		codex: -1,
		"gpt-5.2": -1,
		"gpt-5.1": -1,
	};
	private sessionOffsetApplied: Record<ModelFamily, boolean> = {
		"gpt-5.2-codex": false,
		"codex-max": false,
		codex: false,
		"gpt-5.2": false,
		"gpt-5.1": false,
	};

	private lastToastAccountIndex = -1;
	private lastToastTime = 0;

	static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
		const stored = await loadAccounts();
		return new AccountManager(authFallback, stored);
	}

	constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
		const fallbackAccountId = extractAccountId(authFallback?.access);
		const fallbackEmail = sanitizeEmail(extractAccountEmail(authFallback?.access));

		if (stored && stored.accounts.length > 0) {
			const baseNow = nowMs();
			this.accounts = stored.accounts
				.map((record, index): ManagedAccount | null => {
					if (!record?.refreshToken) return null;
					const matchesFallback =
						!!authFallback &&
						((fallbackAccountId && record.accountId === fallbackAccountId) ||
							record.refreshToken === authFallback.refresh);

					return {
						index,
						accountId: matchesFallback ? fallbackAccountId ?? record.accountId : record.accountId,
						email: matchesFallback ? fallbackEmail ?? record.email : sanitizeEmail(record.email),
						refreshToken: matchesFallback && authFallback ? authFallback.refresh : record.refreshToken,
						access: matchesFallback && authFallback ? authFallback.access : undefined,
						expires: matchesFallback && authFallback ? authFallback.expires : undefined,
						addedAt: clampNonNegativeInt(record.addedAt, baseNow),
						lastUsed: clampNonNegativeInt(record.lastUsed, 0),
						lastSwitchReason: record.lastSwitchReason,
						rateLimitResetTimes: record.rateLimitResetTimes ?? {},
						coolingDownUntil: record.coolingDownUntil,
						cooldownReason: record.cooldownReason,
					};
				})
				.filter((a): a is ManagedAccount => a !== null);

			const hasMatchingFallback =
				!!authFallback &&
				this.accounts.some(
					(a) =>
						a.refreshToken === authFallback.refresh ||
						(fallbackAccountId && a.accountId === fallbackAccountId),
				);

			if (authFallback && !hasMatchingFallback) {
				const now = nowMs();
				this.accounts.push({
					index: this.accounts.length,
					accountId: fallbackAccountId,
					email: fallbackEmail,
					refreshToken: authFallback.refresh,
					access: authFallback.access,
					expires: authFallback.expires,
					addedAt: now,
					lastUsed: now,
					lastSwitchReason: "initial",
					rateLimitResetTimes: {},
				});
			}

			if (this.accounts.length > 0) {
				const defaultIndex =
					clampNonNegativeInt(stored.activeIndex, 0) % this.accounts.length;
				this.cursor = defaultIndex;
				for (const family of MODEL_FAMILIES) {
					const raw = stored.activeIndexByFamily?.[family];
					this.currentAccountIndexByFamily[family] =
						clampNonNegativeInt(raw, defaultIndex) % this.accounts.length;
				}
			}
			return;
		}

		if (authFallback) {
			const now = nowMs();
			this.accounts = [
				{
					index: 0,
					accountId: fallbackAccountId,
					email: fallbackEmail,
					refreshToken: authFallback.refresh,
					access: authFallback.access,
					expires: authFallback.expires,
					addedAt: now,
					lastUsed: 0,
					lastSwitchReason: "initial",
					rateLimitResetTimes: {},
				},
			];
			this.cursor = 0;
			for (const family of MODEL_FAMILIES) {
				this.currentAccountIndexByFamily[family] = 0;
			}
		}
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	getAccountsSnapshot(): ManagedAccount[] {
		return this.accounts.map((a) => ({ ...a, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
	}

	getActiveIndexForFamily(family: ModelFamily): number {
		const idx = this.currentAccountIndexByFamily[family];
		if (idx < 0 || idx >= this.accounts.length) return this.accounts.length > 0 ? 0 : -1;
		return idx;
	}

	setActiveIndex(index: number): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		if (!account) return null;
		for (const family of MODEL_FAMILIES) {
			this.currentAccountIndexByFamily[family] = index;
			this.sessionOffsetApplied[family] = true;
		}
		this.cursor = index;
		account.lastUsed = nowMs();
		account.lastSwitchReason = "rotation";
		return account;
	}

	getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
		const idx = this.currentAccountIndexByFamily[family];
		if (idx < 0 || idx >= this.accounts.length) return null;
		return this.accounts[idx] ?? null;
	}

	private applyPidOffsetOnce(family: ModelFamily): void {
		if (this.sessionOffsetApplied[family]) return;
		if (this.accounts.length <= 1) {
			this.sessionOffsetApplied[family] = true;
			return;
		}

		const offset = process.pid % this.accounts.length;
		const baseIndexRaw = this.currentAccountIndexByFamily[family];
		const baseIndex = baseIndexRaw >= 0 ? baseIndexRaw : 0;
		this.currentAccountIndexByFamily[family] = (baseIndex + offset) % this.accounts.length;
		this.cursor = (this.cursor + offset) % this.accounts.length;
		this.sessionOffsetApplied[family] = true;
	}

	getCurrentOrNextForFamily(
		family: ModelFamily,
		model: string | null | undefined,
		strategy: AccountSelectionStrategy = "sticky",
		pidOffsetEnabled: boolean = false,
	): ManagedAccount | null {
		if (pidOffsetEnabled) this.applyPidOffsetOnce(family);

		if (strategy === "round-robin") {
			const next = this.getNextForFamily(family, model);
			if (next) this.currentAccountIndexByFamily[family] = next.index;
			return next;
		}

		const current = this.getCurrentAccountForFamily(family);
		if (current) {
			clearExpiredRateLimits(current);
			if (!isRateLimitedForFamily(current, family, model) && !this.isAccountCoolingDown(current)) {
				current.lastUsed = nowMs();
				return current;
			}
		}

		const next = this.getNextForFamily(family, model);
		if (next) this.currentAccountIndexByFamily[family] = next.index;
		return next;
	}

	getNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
		const available = this.accounts.filter((a) => {
			clearExpiredRateLimits(a);
			return !isRateLimitedForFamily(a, family, model) && !this.isAccountCoolingDown(a);
		});
		if (available.length === 0) return null;
		const account = available[this.cursor % available.length];
		if (!account) return null;
		this.cursor += 1;
		account.lastUsed = nowMs();
		return account;
	}

	markSwitched(
		account: ManagedAccount,
		reason: "rate-limit" | "initial" | "rotation",
		family: ModelFamily,
	): void {
		account.lastSwitchReason = reason;
		this.currentAccountIndexByFamily[family] = account.index;
	}

	markRateLimited(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		model?: string | null,
	): void {
		const retryMs = Math.max(0, Math.floor(retryAfterMs));
		const resetAt = nowMs() + retryMs;
		account.rateLimitResetTimes[getQuotaKey(family)] = resetAt;
		if (model) account.rateLimitResetTimes[getQuotaKey(family, model)] = resetAt;
	}

	markAccountCoolingDown(
		account: ManagedAccount,
		cooldownMs: number,
		reason: CooldownReason,
	): void {
		const ms = Math.max(0, Math.floor(cooldownMs));
		account.coolingDownUntil = nowMs() + ms;
		account.cooldownReason = reason;
	}

	isAccountCoolingDown(account: ManagedAccount): boolean {
		if (account.coolingDownUntil === undefined) return false;
		if (nowMs() >= account.coolingDownUntil) {
			delete account.coolingDownUntil;
			delete account.cooldownReason;
			return false;
		}
		return true;
	}

	shouldShowAccountToast(accountIndex: number, debounceMs = 30_000): boolean {
		const now = nowMs();
		if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
			return false;
		}
		return true;
	}

	markToastShown(accountIndex: number): void {
		this.lastToastAccountIndex = accountIndex;
		this.lastToastTime = nowMs();
	}

	updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
		account.refreshToken = auth.refresh;
		account.access = auth.access;
		account.expires = auth.expires;
		account.accountId = extractAccountId(auth.access) ?? account.accountId;
		account.email = sanitizeEmail(extractAccountEmail(auth.access)) ?? account.email;
	}

	toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
		return {
			type: "oauth",
			access: account.access ?? "",
			refresh: account.refreshToken,
			expires: account.expires ?? 0,
		};
	}

	async hydrateMissingEmails(): Promise<void> {
		// Best-effort: refresh tokens to decode emails/accountId.
		for (const account of this.accounts) {
			if (account.email && account.accountId) continue;
			try {
				const refreshed = await refreshAccessToken(account.refreshToken);
				if (refreshed.type !== "success") continue;
				account.accountId = extractAccountId(refreshed.access) ?? account.accountId;
				account.email = sanitizeEmail(extractAccountEmail(refreshed.access)) ?? account.email;
				account.refreshToken = refreshed.refresh;
			} catch {
				// ignore
			}
		}
	}

	getMinWaitTimeForFamily(family: ModelFamily, model?: string | null): number {
		const now = nowMs();
		const available = this.accounts.filter((a) => {
			clearExpiredRateLimits(a);
			return !isRateLimitedForFamily(a, family, model) && !this.isAccountCoolingDown(a);
		});
		if (available.length > 0) return 0;

		const waitTimes: number[] = [];
		const baseKey = getQuotaKey(family);
		const modelKey = model ? getQuotaKey(family, model) : null;
		for (const account of this.accounts) {
			const baseReset = account.rateLimitResetTimes[baseKey];
			if (typeof baseReset === "number") waitTimes.push(Math.max(0, baseReset - now));
			if (modelKey) {
				const modelReset = account.rateLimitResetTimes[modelKey];
				if (typeof modelReset === "number") waitTimes.push(Math.max(0, modelReset - now));
			}
			if (typeof account.coolingDownUntil === "number") {
				waitTimes.push(Math.max(0, account.coolingDownUntil - now));
			}
		}
		return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
	}

	async saveToDisk(): Promise<void> {
		const activeIndexByFamily: Partial<Record<string, number>> = {};
		for (const family of MODEL_FAMILIES) {
			activeIndexByFamily[family] = clampNonNegativeInt(
				this.currentAccountIndexByFamily[family],
				0,
			);
		}

		const activeIndex = clampNonNegativeInt(activeIndexByFamily.codex, 0);

		const storage: AccountStorageV3 = {
			version: 3,
			accounts: this.accounts.map((a) => ({
				refreshToken: a.refreshToken,
				accountId: a.accountId,
				email: a.email,
				addedAt: a.addedAt,
				lastUsed: a.lastUsed,
				lastSwitchReason: a.lastSwitchReason,
				rateLimitResetTimes:
					Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
				coolingDownUntil: a.coolingDownUntil,
				cooldownReason: a.cooldownReason,
			})),
			activeIndex,
			activeIndexByFamily,
		};

		await saveAccounts(storage);
	}
}

export function isOAuthAuth(auth: Auth): auth is OAuthAuthDetails {
	return auth.type === "oauth";
}
