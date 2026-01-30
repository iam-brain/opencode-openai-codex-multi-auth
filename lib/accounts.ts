import type { Auth } from "@opencode-ai/sdk";

import { decodeJWT, refreshAccessToken } from "./auth/auth.js";
import { JWT_CLAIM_PATH } from "./constants.js";
import type {
	AccountSelectionStrategy,
	AccountStorageV3,
	CooldownReason,
	OAuthAuthDetails,
	RateLimitStateV3,
	TokenResult,
} from "./types.js";
import { backupAccountsFile, loadAccounts, saveAccounts } from "./storage.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import { getHealthTracker, getTokenTracker, selectHybridAccount } from "./rotation.js";
import { findAccountMatchIndex } from "./account-matching.js";

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

const PLAN_TYPE_LABELS: Record<string, string> = {
	free: "Free",
	plus: "Plus",
	pro: "Pro",
	team: "Team",
	business: "Business",
	enterprise: "Enterprise",
	edu: "Edu",
};

function normalizePlanType(planType: unknown): string | undefined {
	if (typeof planType !== "string") return undefined;
	const trimmed = planType.trim();
	if (!trimmed) return undefined;
	const mapped = PLAN_TYPE_LABELS[trimmed.toLowerCase()];
	return mapped ?? trimmed;
}

export function extractAccountPlan(token?: string): string | undefined {
	if (!token) return undefined;
	const decoded = decodeJWT(token);
	const nested = decoded?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
	return normalizePlanType(nested?.chatgpt_plan_type);
}

export function formatAccountLabel(
	account: { email?: string; plan?: string; accountId?: string } | undefined,
	index: number,
): string {
	const email = account?.email?.trim();
	const plan = account?.plan?.trim();
	const accountId = account?.accountId?.trim();
	const idSuffix = accountId
		? accountId.length > 6
			? accountId.slice(-6)
			: accountId
		: null;

	if (email && plan) return `${email} (${plan})`;
	if (email) return email;
	if (idSuffix) return `id:${idSuffix}`;
	return `Account ${index + 1}`;
}

export function formatWaitTime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function hasCompleteIdentity(account: {
	accountId?: string;
	email?: string;
	plan?: string;
}): boolean {
	return Boolean(account.accountId && account.email && account.plan);
}

function isAccountEnabled(account: { enabled?: boolean }): boolean {
	return account.enabled !== false;
}

export interface ManagedAccount {
	index: number;
	accountId?: string;
	email?: string;
	plan?: string;
	enabled?: boolean;
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

async function migrateLegacyAccounts(storage: AccountStorageV3): Promise<AccountStorageV3> {
	const needsMigration = storage.accounts.some((record) => !hasCompleteIdentity(record));
	if (!needsMigration) return storage;

	let updated = false;
	const migratedAccounts: AccountStorageV3["accounts"] = [];

	for (const record of storage.accounts) {
		if (hasCompleteIdentity(record)) {
			migratedAccounts.push(record);
			continue;
		}
		if (!record.refreshToken) {
			migratedAccounts.push(record);
			continue;
		}
		const result = await refreshAccessToken(record.refreshToken);
		if (result.type !== "success") {
			migratedAccounts.push(record);
			continue;
		}
		const token = result.idToken ?? result.access;
		const accountId = extractAccountId(token);
		const email = sanitizeEmail(extractAccountEmail(token));
		const plan = extractAccountPlan(token);
		if (!accountId || !email || !plan) {
			migratedAccounts.push(record);
			continue;
		}

		updated = true;
		migratedAccounts.push({
			...record,
			accountId,
			email,
			plan,
			refreshToken: result.refresh,
		});
	}

	if (!updated) return storage;
	const backupPath = await backupAccountsFile();
	if (!backupPath) return storage;

	const migrated: AccountStorageV3 = {
		...storage,
		accounts: migratedAccounts,
	};
	await saveAccounts(migrated);
	return migrated;
}

function mergeAccountRecords(
	existing: AccountStorageV3["accounts"],
	incoming: AccountStorageV3["accounts"],
): AccountStorageV3["accounts"] {
	const merged = existing.map((account) => ({
		...account,
		rateLimitResetTimes: account.rateLimitResetTimes
			? { ...account.rateLimitResetTimes }
			: undefined,
	}));

	for (const candidate of incoming) {
		const matchIndex = findAccountMatchIndex(merged, {
			accountId: candidate.accountId,
			plan: candidate.plan,
			email: candidate.email,
		});
		if (matchIndex < 0) {
			merged.push({
				...candidate,
				rateLimitResetTimes: candidate.rateLimitResetTimes
					? { ...candidate.rateLimitResetTimes }
					: undefined,
			});
			continue;
		}

		const current = merged[matchIndex];
		if (!current) continue;
		const updated = { ...current };

		if (candidate.refreshToken && candidate.refreshToken !== updated.refreshToken) {
			updated.refreshToken = candidate.refreshToken;
		}
		if (!updated.accountId && candidate.accountId) {
			updated.accountId = candidate.accountId;
		}
		if (!updated.email && candidate.email) {
			updated.email = candidate.email;
		}
		if (!updated.plan && candidate.plan) {
			updated.plan = candidate.plan;
		}
		if (typeof candidate.enabled === "boolean" && candidate.enabled !== updated.enabled) {
			updated.enabled = candidate.enabled;
		}

		if (
			typeof candidate.addedAt === "number" &&
			Number.isFinite(candidate.addedAt) &&
			(typeof updated.addedAt !== "number" || candidate.addedAt < updated.addedAt)
		) {
			updated.addedAt = candidate.addedAt;
		}
		if (
			typeof candidate.lastUsed === "number" &&
			Number.isFinite(candidate.lastUsed) &&
			(typeof updated.lastUsed !== "number" || candidate.lastUsed > updated.lastUsed)
		) {
			updated.lastUsed = candidate.lastUsed;
		}
		if (candidate.lastSwitchReason) {
			updated.lastSwitchReason = candidate.lastSwitchReason;
		}

		if (candidate.rateLimitResetTimes) {
			const mergedRateLimits = { ...updated.rateLimitResetTimes };
			for (const [key, value] of Object.entries(candidate.rateLimitResetTimes)) {
				const currentValue = mergedRateLimits[key];
				if (typeof value === "number") {
					mergedRateLimits[key] =
						typeof currentValue === "number" ? Math.max(currentValue, value) : value;
				}
			}
			updated.rateLimitResetTimes = mergedRateLimits;
		}
		if (
			typeof candidate.coolingDownUntil === "number" &&
			Number.isFinite(candidate.coolingDownUntil)
		) {
			const currentCooldown =
				typeof updated.coolingDownUntil === "number" &&
				Number.isFinite(updated.coolingDownUntil)
					? updated.coolingDownUntil
					: undefined;
			if (currentCooldown === undefined || candidate.coolingDownUntil > currentCooldown) {
				updated.coolingDownUntil = candidate.coolingDownUntil;
			}
		}
		if (candidate.cooldownReason && !updated.cooldownReason) {
			updated.cooldownReason = candidate.cooldownReason;
		}

		merged[matchIndex] = updated;
	}

	return merged;
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
	private refreshInFlight = new Map<number, Promise<TokenResult>>();

	static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
		const stored = await loadAccounts();
		const migrated = stored ? await migrateLegacyAccounts(stored) : stored;
		return new AccountManager(authFallback, migrated);
	}

	constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
		const fallbackAccountId = extractAccountId(authFallback?.access);
		const fallbackEmail = sanitizeEmail(extractAccountEmail(authFallback?.access));
		const fallbackPlan = extractAccountPlan(authFallback?.access);
		const hasFallbackIdentity = Boolean(fallbackAccountId && fallbackEmail && fallbackPlan);

		if (stored && stored.accounts.length > 0) {
			const baseNow = nowMs();
			const fallbackMatchIndex = (() => {
				if (!authFallback || !hasFallbackIdentity) return -1;
				return findAccountMatchIndex(stored.accounts, {
					accountId: fallbackAccountId,
					plan: fallbackPlan,
					email: fallbackEmail,
				});
			})();
			this.accounts = stored.accounts
				.map((record, index): ManagedAccount | null => {
					if (!record?.refreshToken) return null;
					const matchesFallback = !!authFallback && index === fallbackMatchIndex;

					return {
						index,
						accountId: matchesFallback ? fallbackAccountId ?? record.accountId : record.accountId,
						email: matchesFallback ? fallbackEmail ?? record.email : sanitizeEmail(record.email),
						plan: matchesFallback ? fallbackPlan ?? record.plan : record.plan,
					enabled: record.enabled !== false,
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

			const hasMatchingFallback = !!authFallback && fallbackMatchIndex >= 0;

			if (authFallback && hasFallbackIdentity && !hasMatchingFallback) {
				const now = nowMs();
				this.accounts.push({
					index: this.accounts.length,
					accountId: fallbackAccountId,
					email: fallbackEmail,
					plan: fallbackPlan,
					enabled: true,
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

		if (authFallback && hasFallbackIdentity) {
			const now = nowMs();
			this.accounts = [
				{
					index: 0,
					accountId: fallbackAccountId,
					email: fallbackEmail,
					plan: fallbackPlan,
					enabled: true,
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
		return this.accounts.filter(
			(account) => hasCompleteIdentity(account) && isAccountEnabled(account),
		).length;
	}

	getAccountsSnapshot(): ManagedAccount[] {
		return this.accounts.map((a) => ({ ...a, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
	}

	getAccountByIndex(index: number): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		return this.accounts[index] ?? null;
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
		// antigravity-style: PID offset is primarily for sticky/round-robin.
		if (pidOffsetEnabled && strategy !== "hybrid") this.applyPidOffsetOnce(family);

		if (strategy === "hybrid") {
			const healthTracker = getHealthTracker();
			const tokenTracker = getTokenTracker();

			const eligibleAccounts = this.accounts.filter(
				(acc) => hasCompleteIdentity(acc) && isAccountEnabled(acc),
			);
			const accountsWithMetrics = eligibleAccounts.map((acc) => {
				clearExpiredRateLimits(acc);
				return {
					index: acc.index,
					lastUsed: acc.lastUsed,
					healthScore: healthTracker.getScore(acc.index),
					isRateLimited: isRateLimitedForFamily(acc, family, model),
					isCoolingDown: this.isAccountCoolingDown(acc),
				};
			});

			const currentIndex =
				this.currentAccountIndexByFamily[family] >= 0
					? this.currentAccountIndexByFamily[family]
					: null;
			const selectedIndex = selectHybridAccount(
				accountsWithMetrics,
				tokenTracker,
				currentIndex,
			);
			if (selectedIndex !== null) {
				const selected = this.accounts[selectedIndex];
				if (selected) {
					this.currentAccountIndexByFamily[family] = selected.index;
					return selected;
				}
			}
			// Fall through to sticky selection if hybrid has no eligible candidates.
		}

		if (pidOffsetEnabled) this.applyPidOffsetOnce(family);

		if (strategy === "round-robin") {
			const next = this.getNextForFamily(family, model);
			if (next) this.currentAccountIndexByFamily[family] = next.index;
			return next;
		}

		const current = this.getCurrentAccountForFamily(family);
		if (current && hasCompleteIdentity(current) && isAccountEnabled(current)) {
			clearExpiredRateLimits(current);
			if (!isRateLimitedForFamily(current, family, model) && !this.isAccountCoolingDown(current)) {
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
			return (
				hasCompleteIdentity(a) &&
				isAccountEnabled(a) &&
				!isRateLimitedForFamily(a, family, model) &&
				!this.isAccountCoolingDown(a)
			);
		});
		if (available.length === 0) return null;
		const account = available[this.cursor % available.length];
		if (!account) return null;
		this.cursor += 1;
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
		const baseKey = getQuotaKey(family);
		account.rateLimitResetTimes[baseKey] = resetAt;
		if (model && model !== family) {
			const modelKey = getQuotaKey(family, model);
			account.rateLimitResetTimes[modelKey] = resetAt;
		}
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

	markAccountUsed(accountIndex: number): void {
		const account = this.accounts.find((a) => a.index === accountIndex);
		if (!account) return;
		account.lastUsed = nowMs();
	}

	updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
		account.refreshToken = auth.refresh;
		account.access = auth.access;
		account.expires = auth.expires;
		account.accountId = extractAccountId(auth.access) ?? account.accountId;
		account.email = sanitizeEmail(extractAccountEmail(auth.access)) ?? account.email;
		account.plan = extractAccountPlan(auth.access) ?? account.plan;
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
		try {
			await backupAccountsFile();
		} catch {
			// ignore backup failures
		}
		for (const account of this.accounts) {
			if (account.enabled === undefined) account.enabled = true;
			if (account.email && account.accountId) continue;
			try {
				const refreshed = await this.refreshAccountWithLock(account);
				if (refreshed.type !== "success") continue;
				const tokenForClaims = refreshed.idToken ?? refreshed.access;
				account.accountId = extractAccountId(tokenForClaims) ?? account.accountId;
				account.email = sanitizeEmail(extractAccountEmail(tokenForClaims)) ?? account.email;
				account.plan = extractAccountPlan(tokenForClaims) ?? account.plan;
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

	async refreshAccountWithLock(
		account: ManagedAccount,
		refreshFn: (refreshToken: string) => Promise<TokenResult> = refreshAccessToken,
	): Promise<TokenResult> {
		const existing = this.refreshInFlight.get(account.index);
		if (existing) return existing;

		const refreshPromise = (async () => {
			try {
				return await refreshFn(account.refreshToken);
			} finally {
				this.refreshInFlight.delete(account.index);
			}
		})();

		this.refreshInFlight.set(account.index, refreshPromise);
		return refreshPromise;
	}

	async refreshAccountWithFallback(
		account: ManagedAccount,
		refreshFn: (refreshToken: string) => Promise<TokenResult> = refreshAccessToken,
	): Promise<TokenResult> {
		const first = await this.refreshAccountWithLock(account, refreshFn);
		if (first.type === "success") return first;

		const latest = await loadAccounts().catch(() => null);
		if (!latest?.accounts || latest.accounts.length === 0) return first;

		const matchIndex = findAccountMatchIndex(latest.accounts, {
			accountId: account.accountId,
			plan: account.plan,
			email: account.email,
		});
		if (matchIndex < 0) return first;

		const latestRecord = latest.accounts[matchIndex];
		if (!latestRecord?.refreshToken || latestRecord.refreshToken === account.refreshToken) {
			return first;
		}

		account.refreshToken = latestRecord.refreshToken;
		if (!account.accountId && latestRecord.accountId) account.accountId = latestRecord.accountId;
		if (!account.email && latestRecord.email) account.email = latestRecord.email;
		if (!account.plan && latestRecord.plan) account.plan = latestRecord.plan;

		return this.refreshAccountWithLock(account, refreshFn);
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

		const snapshot = this.accounts.map((a) => ({
			refreshToken: a.refreshToken,
			accountId: a.accountId,
			email: a.email,
			plan: a.plan,
			enabled: a.enabled !== false,
			addedAt: a.addedAt,
			lastUsed: a.lastUsed,
			lastSwitchReason: a.lastSwitchReason,
			rateLimitResetTimes:
				Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
			coolingDownUntil: a.coolingDownUntil,
			cooldownReason: a.cooldownReason,
		}));

		let accountsToSave: AccountStorageV3["accounts"] = snapshot;
		try {
			const latest = await loadAccounts();
			if (latest?.accounts && latest.accounts.length > 0) {
				accountsToSave = mergeAccountRecords(latest.accounts, snapshot);
			}
		} catch {
			accountsToSave = snapshot;
		}

		const storage: AccountStorageV3 = {
			version: 3,
			accounts: accountsToSave,
			activeIndex: Math.min(activeIndex, Math.max(0, accountsToSave.length - 1)),
			activeIndexByFamily,
		};

		await saveAccounts(storage);
	}
}

export function isOAuthAuth(auth: Auth): auth is OAuthAuthDetails {
	return auth.type === "oauth";
}
