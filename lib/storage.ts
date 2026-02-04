import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import lockfile from "proper-lockfile";

import type { AccountStorageV3 } from "./types.js";
import { findAccountMatchIndex } from "./account-matching.js";
import { getOpencodeConfigDir as getSystemConfigDir } from "./paths.js";
import { normalizePlanType } from "./plan-utils.js";
import { getAuthDebugEnabled } from "./config.js";

type AccountRecord = AccountStorageV3["accounts"][number];

type RateLimitState = Record<string, number | undefined>;

const STORAGE_FILE = "openai-codex-accounts.json";
const AUTH_DEBUG_ENABLED = getAuthDebugEnabled();
// Limit quarantine and backup files to prevent unbounded disk usage.
const MAX_QUARANTINE_FILES = 20;
const MAX_BACKUP_FILES = 20;

type StorageScope = "global" | "project";

let storagePathOverride: string | null = null;
let storageScopeOverride: StorageScope = "global";

function findClosestProjectAccountsFile(startDir: string): string | null {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, ".opencode", STORAGE_FILE);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function configureStorageForCwd(options: {
	cwd: string;
	perProjectAccounts: boolean;
}): { scope: StorageScope; storagePath: string } {
	if (!options.perProjectAccounts) {
		storagePathOverride = null;
		storageScopeOverride = "global";
		return { scope: "global", storagePath: getStoragePath() };
	}

	const projectPath = findClosestProjectAccountsFile(options.cwd);
	if (projectPath) {
		storagePathOverride = projectPath;
		storageScopeOverride = "project";
		return { scope: "project", storagePath: projectPath };
	}

	storagePathOverride = null;
	storageScopeOverride = "global";
	return { scope: "global", storagePath: getStoragePath() };
}

export function getStorageScope(): { scope: StorageScope; storagePath: string } {
	return { scope: storageScopeOverride, storagePath: getStoragePath() };
}

export function getOpencodeConfigDir(): string {
	if (storageScopeOverride === "project" && storagePathOverride) {
		return dirname(storagePathOverride);
	}
	return getSystemConfigDir();
}

function debug(...args: unknown[]): void {
	if (!AUTH_DEBUG_ENABLED) return;
	console.debug(...args);
}

function hasCompleteIdentity(record: {
	accountId?: string;
	email?: string;
	plan?: string;
}): boolean {
	return Boolean(record.accountId && record.email && record.plan);
}

function normalizeAccountRecord(candidate: unknown, now: number): AccountRecord | null {
	if (!candidate || typeof candidate !== "object") return null;
	const record = candidate as Record<string, unknown>;

	const refreshTokenRaw =
		typeof record.refreshToken === "string"
			? record.refreshToken
			: typeof record.refresh_token === "string"
				? record.refresh_token
				: typeof record.refresh === "string"
					? record.refresh
					: undefined;
	const refreshToken = typeof refreshTokenRaw === "string" ? refreshTokenRaw.trim() : "";
	if (!refreshToken) return null;

	const accountIdRaw =
		typeof record.accountId === "string"
			? record.accountId
			: typeof record.account_id === "string"
				? record.account_id
				: undefined;
	const accountId = typeof accountIdRaw === "string" && accountIdRaw.trim() ? accountIdRaw : undefined;

	const emailRaw = typeof record.email === "string" ? record.email : undefined;
	const email = typeof emailRaw === "string" && emailRaw.trim() ? emailRaw : undefined;

	const planRaw =
		typeof record.plan === "string"
			? record.plan
			: typeof record.chatgpt_plan_type === "string"
				? record.chatgpt_plan_type
				: undefined;
	const plan = normalizePlanType(planRaw);
	const enabled = typeof record.enabled === "boolean" ? record.enabled : undefined;

	const addedAt =
		typeof record.addedAt === "number" && Number.isFinite(record.addedAt)
			? record.addedAt
			: now;
	const lastUsed =
		typeof record.lastUsed === "number" && Number.isFinite(record.lastUsed)
			? record.lastUsed
			: now;

	const lastSwitchReason =
		typeof record.lastSwitchReason === "string" ? record.lastSwitchReason : undefined;

	const rateLimitResetTimes =
		record.rateLimitResetTimes && typeof record.rateLimitResetTimes === "object"
			? (record.rateLimitResetTimes as RateLimitState)
			: undefined;
	const coolingDownUntil =
		typeof record.coolingDownUntil === "number" && Number.isFinite(record.coolingDownUntil)
			? record.coolingDownUntil
			: undefined;
	const cooldownReasonRaw =
		typeof record.cooldownReason === "string" ? record.cooldownReason : undefined;
	const cooldownReason = cooldownReasonRaw === "auth-failure" ? "auth-failure" : undefined;

	return {
		refreshToken,
		accountId,
		email,
		plan,
		enabled,
		addedAt: Math.max(0, Math.floor(addedAt)),
		lastUsed: Math.max(0, Math.floor(lastUsed)),
		lastSwitchReason:
			lastSwitchReason === "rate-limit" ||
			lastSwitchReason === "initial" ||
			lastSwitchReason === "rotation"
				? lastSwitchReason
				: undefined,
		rateLimitResetTimes,
		coolingDownUntil,
		cooldownReason,
	};
}

const LOCK_OPTIONS = {
	stale: 10_000,
	retries: {
		retries: 5,
		minTimeout: 100,
		maxTimeout: 1000,
		factor: 2,
	},
	realpath: false,
};

async function ensureFileExists(path: string): Promise<void> {
	if (existsSync(path)) return;
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(
		path,
		JSON.stringify(
			{ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} },
			null,
			2,
		),
		// Mode 0o600: Owner read/write only (prevents leaks of refresh tokens).
		{ encoding: "utf-8", mode: 0o600 },
	);
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	let release: (() => Promise<void>) | null = null;
	try {
		await ensureFileExists(path).catch(() => undefined);
		release = await lockfile.lock(path, LOCK_OPTIONS);
		return await fn();
	} finally {
		if (release) {
			try {
				await release();
			} catch { }
		}
	}
}

async function cleanupQuarantineFiles(storagePath: string): Promise<void> {
	try {
		const dir = dirname(storagePath);
		const entries = await fs.readdir(dir);
		const prefix = `${STORAGE_FILE}.quarantine-`;
		const matches = entries
			.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
			.map((name) => {
				const stampRaw = name.slice(prefix.length, name.length - ".json".length);
				const stamp = Number.parseInt(stampRaw, 10);
				return {
					name,
					stamp: Number.isFinite(stamp) ? stamp : 0,
				};
			})
			.sort((a, b) => a.stamp - b.stamp);

		if (matches.length <= MAX_QUARANTINE_FILES) return;
		const toDelete = matches.slice(0, matches.length - MAX_QUARANTINE_FILES);
		await Promise.all(
			toDelete.map(async (entry) => {
				try {
					await fs.unlink(join(dir, entry.name));
				} catch { }
			}),
		);
	} catch { }
}

async function cleanupBackupFiles(storagePath: string): Promise<void> {
	try {
		const dir = dirname(storagePath);
		const entries = await fs.readdir(dir);
		const prefix = `${STORAGE_FILE}.bak-`;
		const matches = entries
			.filter((name) => name.startsWith(prefix))
			.map((name) => {
				const stampRaw = name.slice(prefix.length);
				const stamp = Number.parseInt(stampRaw, 10);
				return {
					name,
					stamp: Number.isFinite(stamp) ? stamp : 0,
				};
			})
			.sort((a, b) => a.stamp - b.stamp);

		if (matches.length <= MAX_BACKUP_FILES) return;
		const toDelete = matches.slice(0, matches.length - MAX_BACKUP_FILES);
		await Promise.all(
			toDelete.map(async (entry) => {
				try {
					await fs.unlink(join(dir, entry.name));
				} catch { }
			}),
		);
	} catch { }
}

function getLegacyOpencodeDir(): string {
	return join(homedir(), ".opencode");
}

export function getStoragePath(): string {
	if (storagePathOverride) return storagePathOverride;
	return join(getOpencodeConfigDir(), STORAGE_FILE);
}

export function getCachePath(filename: string): string {
	return join(getSystemConfigDir(), "cache", filename);
}

export type AccountsInspection = {
	status: "missing" | "corrupt-file" | "ok" | "needs-repair";
	corruptEntries: unknown[];
	legacyEntries: AccountRecord[];
	validEntries: AccountRecord[];
	reason?: string;
};

export async function backupAccountsFile(): Promise<string | null> {
	const filePath = getStoragePath();
	if (!existsSync(filePath)) return null;
	const backupPath = `${filePath}.bak-${Date.now()}`;
	await withFileLock(filePath, async () => {
		if (!existsSync(filePath)) return;
		const content = await fs.readFile(filePath);
		await fs.writeFile(backupPath, content, { mode: 0o600 });
		await cleanupBackupFiles(filePath);
	});
	return backupPath;
}

function getLegacyStoragePath(): string {
	return join(getLegacyOpencodeDir(), STORAGE_FILE);
}

function normalizeStorage(parsed: unknown): AccountStorageV3 | null {
	const now = Date.now();

	let accountsSource: unknown;
	let activeIndexSource: unknown = 0;
	let activeIndexByFamilySource: unknown = undefined;

	if (Array.isArray(parsed)) {
		accountsSource = parsed;
	} else if (parsed && typeof parsed === "object") {
		const storage = parsed as Record<string, unknown>;
		accountsSource = storage.accounts;
		activeIndexSource = storage.activeIndex;
		activeIndexByFamilySource = storage.activeIndexByFamily;
	} else {
		return null;
	}

	if (!Array.isArray(accountsSource)) return null;
	const normalizedAccounts = accountsSource
		.map((entry) => normalizeAccountRecord(entry, now))
		.filter((a): a is AccountRecord => a !== null);
	const activeIndexRaw =
		typeof activeIndexSource === "number" && Number.isFinite(activeIndexSource)
			? Math.max(0, Math.floor(activeIndexSource))
			: 0;
	const activeIndexClamped =
		normalizedAccounts.length > 0
			? Math.min(activeIndexRaw, normalizedAccounts.length - 1)
			: 0;
	const activeCandidate = normalizedAccounts[activeIndexClamped] ?? null;

	const activeIndexByFamilyRaw =
		(activeIndexByFamilySource && typeof activeIndexByFamilySource === "object"
			? (activeIndexByFamilySource as AccountStorageV3["activeIndexByFamily"])
			: {}) ?? {};
	const activeCandidatesByFamily: Record<string, AccountRecord> = {};
	for (const [family, index] of Object.entries(activeIndexByFamilyRaw)) {
		if (typeof index !== "number" || !Number.isFinite(index)) continue;
		const clamped =
			normalizedAccounts.length > 0
				? Math.min(Math.max(0, Math.floor(index)), normalizedAccounts.length - 1)
				: 0;
		const candidate = normalizedAccounts[clamped];
		if (candidate) activeCandidatesByFamily[family] = candidate;
	}

	const { accounts } = dedupeRefreshTokens(normalizedAccounts);
	if (accounts.length === 0) return null;

	const mappedActiveIndex = activeCandidate
		? findAccountMatchIndex(accounts, {
				accountId: activeCandidate.accountId,
				plan: activeCandidate.plan,
				email: activeCandidate.email,
			})
		: -1;
	const fallbackActiveIndex =
		accounts.length > 0 ? Math.min(activeIndexRaw, accounts.length - 1) : 0;
	const clampedActiveIndex =
		mappedActiveIndex >= 0 ? mappedActiveIndex : fallbackActiveIndex;

	const activeIndexByFamily: AccountStorageV3["activeIndexByFamily"] = {};
	for (const [family, candidate] of Object.entries(activeCandidatesByFamily)) {
		const mappedIndex = findAccountMatchIndex(accounts, {
			accountId: candidate.accountId,
			plan: candidate.plan,
			email: candidate.email,
		});
		activeIndexByFamily[family] = mappedIndex >= 0 ? mappedIndex : clampedActiveIndex;
	}

	return {
		version: 3,
		accounts,
		activeIndex: clampedActiveIndex,
		activeIndexByFamily,
	};
}

function areRateLimitStatesEqual(left: RateLimitState, right: RateLimitState): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

function shouldPreferDuplicate(candidate: AccountRecord, existing: AccountRecord): boolean {
	if (candidate.lastUsed !== existing.lastUsed) {
		return candidate.lastUsed > existing.lastUsed;
	}
	return candidate.addedAt > existing.addedAt;
}

function dedupeRefreshTokens(accounts: AccountRecord[]): {
	accounts: AccountRecord[];
	changed: boolean;
} {
	const deduped: AccountRecord[] = [];
	const indexByToken = new Map<string, number>();
	let changed = false;

	for (const account of accounts) {
		const existingIndex = indexByToken.get(account.refreshToken);
		if (existingIndex === undefined) {
			indexByToken.set(account.refreshToken, deduped.length);
			deduped.push(account);
			continue;
		}
		const existing = deduped[existingIndex];
		if (!existing) continue;
		if (shouldPreferDuplicate(account, existing)) {
			deduped[existingIndex] = account;
		}
		changed = true;
	}

	return { accounts: deduped, changed };
}

type MergeAccountsOptions = {
	preserveRefreshTokens?: boolean;
};

type SaveAccountsOptions = MergeAccountsOptions & {
	replace?: boolean;
};

function mergeAccounts(
	existing: AccountRecord[],
	incoming: AccountRecord[],
	options?: MergeAccountsOptions,
): { accounts: AccountRecord[]; changed: boolean } {
	const merged = existing.map((account) => ({ ...account }));
	let changed = false;

	for (const candidate of incoming) {
		let matchIndex = findAccountMatchIndex(merged, {
			accountId: candidate.accountId,
			plan: candidate.plan,
			email: candidate.email,
		});
		if (matchIndex < 0 && (!candidate.accountId || !candidate.email || !candidate.plan)) {
			matchIndex = merged.findIndex(
				(account) => account.refreshToken === candidate.refreshToken,
			);
		}
		if (matchIndex < 0) {
			merged.push({ ...candidate });
			changed = true;
			continue;
		}

		const current = merged[matchIndex];
		const updated = { ...current };
		let didUpdate = false;

		if (candidate.refreshToken && candidate.refreshToken !== updated.refreshToken) {
			const shouldPreserve = options?.preserveRefreshTokens === true;
			const isNewer = (candidate.lastUsed || 0) > (updated.lastUsed || 0);
			if (!shouldPreserve && isNewer) {
				updated.refreshToken = candidate.refreshToken;
				didUpdate = true;
			}
		}
		if (!updated.accountId && candidate.accountId) {
			updated.accountId = candidate.accountId;
			didUpdate = true;
		}
		if (!updated.email && candidate.email) {
			updated.email = candidate.email;
			didUpdate = true;
		}
		if (!updated.plan && candidate.plan) {
			updated.plan = candidate.plan;
			didUpdate = true;
		}
		if (typeof candidate.enabled === "boolean" && candidate.enabled !== updated.enabled) {
			updated.enabled = candidate.enabled;
			didUpdate = true;
		}

		const candidateAddedAt =
			typeof candidate.addedAt === "number" && Number.isFinite(candidate.addedAt)
				? candidate.addedAt
				: undefined;
		const currentAddedAt =
			typeof updated.addedAt === "number" && Number.isFinite(updated.addedAt)
				? updated.addedAt
				: undefined;
		if (
			typeof candidateAddedAt === "number" &&
			(typeof currentAddedAt !== "number" || candidateAddedAt < currentAddedAt)
		) {
			updated.addedAt = candidateAddedAt;
			didUpdate = true;
		}

		const candidateLastUsed =
			typeof candidate.lastUsed === "number" && Number.isFinite(candidate.lastUsed)
				? candidate.lastUsed
				: undefined;
		const currentLastUsed =
			typeof updated.lastUsed === "number" && Number.isFinite(updated.lastUsed)
				? updated.lastUsed
				: undefined;
		if (
			typeof candidateLastUsed === "number" &&
			(typeof currentLastUsed !== "number" || candidateLastUsed > currentLastUsed)
		) {
			updated.lastUsed = candidateLastUsed;
			didUpdate = true;
		}

		if (candidate.lastSwitchReason && !updated.lastSwitchReason) {
			updated.lastSwitchReason = candidate.lastSwitchReason;
			didUpdate = true;
		}

		if (candidate.rateLimitResetTimes) {
			const mergedRateLimits: RateLimitState = { ...(updated.rateLimitResetTimes ?? {}) };
			for (const [key, value] of Object.entries(candidate.rateLimitResetTimes)) {
				if (typeof value !== "number") continue;
				const currentValue = mergedRateLimits[key];
				mergedRateLimits[key] =
					typeof currentValue === "number" ? Math.max(currentValue, value) : value;
			}
			const currentRateLimits = updated.rateLimitResetTimes ?? {};
			if (!areRateLimitStatesEqual(currentRateLimits, mergedRateLimits)) {
				updated.rateLimitResetTimes = mergedRateLimits;
				didUpdate = true;
			}
		}

		if (typeof candidate.coolingDownUntil === "number") {
			const currentCooldown =
				typeof updated.coolingDownUntil === "number" &&
				Number.isFinite(updated.coolingDownUntil)
					? updated.coolingDownUntil
					: undefined;
			if (
				typeof currentCooldown !== "number" ||
				candidate.coolingDownUntil > currentCooldown
			) {
				updated.coolingDownUntil = candidate.coolingDownUntil;
				didUpdate = true;
			}
		}

		if (candidate.cooldownReason && !updated.cooldownReason) {
			updated.cooldownReason = candidate.cooldownReason;
			didUpdate = true;
		}

		if (didUpdate) {
			merged[matchIndex] = updated;
			changed = true;
		}
	}

	const deduped = dedupeRefreshTokens(merged);
	if (deduped.changed) changed = true;
	return { accounts: deduped.accounts, changed };
}

function findAccountIndexByIdentityOrToken(
	accounts: AccountRecord[],
	candidate: AccountRecord | null,
): number {
	if (!candidate) return -1;
	const matchIndex = findAccountMatchIndex(accounts, {
		accountId: candidate.accountId,
		plan: candidate.plan,
		email: candidate.email,
	});
	if (matchIndex >= 0) return matchIndex;
	if (!candidate.accountId || !candidate.email || !candidate.plan) {
		return accounts.findIndex((account) => account.refreshToken === candidate.refreshToken);
	}
	return -1;
}

function mergeAccountStorage(
	existing: AccountStorageV3,
	incoming: AccountStorageV3,
	options?: MergeAccountsOptions,
): AccountStorageV3 {
	const { accounts: mergedAccounts } = mergeAccounts(
		existing.accounts,
		incoming.accounts,
		options,
	);
	const getAccountAtIndex = (
		source: AccountStorageV3,
		index: number | undefined,
	): AccountRecord | null => {
		if (typeof index !== "number" || !Number.isFinite(index)) return null;
		if (source.accounts.length === 0) return null;
		const clamped = Math.min(Math.max(0, Math.floor(index)), source.accounts.length - 1);
		return source.accounts[clamped] ?? null;
	};

	const incomingActive = getAccountAtIndex(incoming, incoming.activeIndex);
	const mappedIndex = findAccountIndexByIdentityOrToken(mergedAccounts, incomingActive);
	const baseActiveIndex =
		mappedIndex >= 0
			? mappedIndex
			: incoming.accounts.length > 0
				? incoming.activeIndex
				: existing.activeIndex;
	const activeIndex =
		mergedAccounts.length > 0
			? Math.min(Math.max(0, baseActiveIndex), mergedAccounts.length - 1)
			: 0;
	const activeIndexByFamily: AccountStorageV3["activeIndexByFamily"] = {};
	const families = new Set([
		...Object.keys(existing.activeIndexByFamily ?? {}),
		...Object.keys(incoming.activeIndexByFamily ?? {}),
	]);
	for (const family of families) {
		const incomingIndex = incoming.activeIndexByFamily?.[family];
		const incomingAccount = getAccountAtIndex(incoming, incomingIndex);
		let mappedFamilyIndex = findAccountIndexByIdentityOrToken(
			mergedAccounts,
			incomingAccount,
		);
		if (mappedFamilyIndex < 0) {
			const existingIndex = existing.activeIndexByFamily?.[family];
			const existingAccount = getAccountAtIndex(existing, existingIndex);
			mappedFamilyIndex = findAccountIndexByIdentityOrToken(
				mergedAccounts,
				existingAccount,
			);
		}
		activeIndexByFamily[family] = mappedFamilyIndex >= 0 ? mappedFamilyIndex : activeIndex;
	}
	return {
		version: 3,
		accounts: mergedAccounts,
		activeIndex,
		activeIndexByFamily,
	};
}

async function migrateLegacyAccountsFileIfNeeded(): Promise<void> {
	const newPath = getStoragePath();
	const legacyPath = getLegacyStoragePath();
	if (!existsSync(legacyPath)) return;
	await withFileLock(newPath, async () => {
		await migrateLegacyAccountsFileIfNeededLocked(newPath, legacyPath);
	});
}

async function migrateLegacyAccountsFileIfNeededLocked(
	newPath: string,
	legacyPath: string,
): Promise<void> {
	if (getStorageScope().scope === "project") return;
	if (!existsSync(legacyPath)) return;
	try {
		const [newRaw, legacyRaw] = await Promise.all([
			fs.readFile(newPath, "utf-8"),
			fs.readFile(legacyPath, "utf-8"),
		]);
		const newStorage = normalizeStorage(JSON.parse(newRaw));
		const legacyStorage = normalizeStorage(JSON.parse(legacyRaw));

		if (!legacyStorage || legacyStorage.accounts.length === 0) return;

		if (!newStorage) {
			debug("[StorageMigration] New storage invalid, adopting legacy accounts");
			await fs.writeFile(newPath, JSON.stringify(legacyStorage, null, 2), { encoding: "utf-8", mode: 0o600 });
			try {
				await fs.unlink(legacyPath);
			} catch { }
			return;
		}

		const { accounts: mergedAccounts, changed } = mergeAccounts(
			newStorage.accounts,
			legacyStorage.accounts,
		);

		if (!changed) return;

		const baseActiveIndex =
			newStorage.accounts.length > 0 ? newStorage.activeIndex : legacyStorage.activeIndex;
		const activeIndex =
			mergedAccounts.length > 0
				? Math.min(Math.max(0, baseActiveIndex), mergedAccounts.length - 1)
				: 0;
		const activeIndexByFamily = {
			...legacyStorage.activeIndexByFamily,
			...newStorage.activeIndexByFamily,
		};
		const mergedStorage: AccountStorageV3 = {
			version: 3,
			accounts: mergedAccounts,
			activeIndex,
			activeIndexByFamily,
		};

		debug(
			`[StorageMigration] Merged legacy accounts (new: ${newStorage.accounts.length}, legacy: ${legacyStorage.accounts.length}, merged: ${mergedAccounts.length})`,
		);
		await fs.writeFile(newPath, JSON.stringify(mergedStorage, null, 2), { encoding: "utf-8", mode: 0o600 });

		try {
			await fs.unlink(legacyPath);
		} catch { }
	} catch { }
}

export async function loadAccountsUnsafe(filePath: string): Promise<AccountStorageV3 | null> {
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return normalizeStorage(parsed);
	} catch {
		return null;
	}
}

export async function saveAccountsWithLock(

	mergeFn: (existing: AccountStorageV3 | null) => AccountStorageV3,
): Promise<void> {
	const filePath = getStoragePath();
	debug(`[SaveAccountsWithLock] Saving to ${filePath}`);

	try {
		await withFileLock(filePath, async () => {
			await migrateLegacyAccountsFileIfNeededLocked(filePath, getLegacyStoragePath());
			const existing = await loadAccountsUnsafe(filePath);
			const mergedStorage = mergeFn(existing);
			const jsonContent = JSON.stringify(mergedStorage, null, 2);
			debug(`[SaveAccountsWithLock] Writing ${jsonContent.length} bytes`);
			
			// Atomic write pattern: write to tmp file then rename to destination.
			// This prevents data corruption during partial writes or power loss.
			const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
			try {
				await fs.writeFile(tmpPath, jsonContent, { encoding: "utf-8", mode: 0o600 });
				await fs.rename(tmpPath, filePath);
			} catch (error) {
				try {
					await fs.unlink(tmpPath);
				} catch { }
				throw error;
			}
		});
	} catch (error) {
		console.error("[SaveAccountsWithLock] Error saving accounts:", error);
		throw error;
	}
}

function extractAccountsSource(parsed: unknown): {
	accountsSource: unknown[];
	activeIndexSource: unknown;
	activeIndexByFamilySource: unknown;
} | null {
	if (Array.isArray(parsed)) {
		return { accountsSource: parsed, activeIndexSource: 0, activeIndexByFamilySource: undefined };
	}
	if (parsed && typeof parsed === "object") {
		const storage = parsed as Record<string, unknown>;
		if (!Array.isArray(storage.accounts)) return null;
		return {
			accountsSource: storage.accounts,
			activeIndexSource: storage.activeIndex,
			activeIndexByFamilySource: storage.activeIndexByFamily,
		};
	}
	return null;
}

export async function inspectAccountsFile(): Promise<AccountsInspection> {
	const filePath = getStoragePath();
	if (!existsSync(filePath)) {
		return { status: "missing", corruptEntries: [], legacyEntries: [], validEntries: [] };
	}
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const source = extractAccountsSource(parsed);
		if (!source) {
			return {
				status: "corrupt-file",
				reason: "invalid-shape",
				corruptEntries: [],
				legacyEntries: [],
				validEntries: [],
			};
		}
		const now = Date.now();
		const corruptEntries: unknown[] = [];
		const legacyEntries: AccountRecord[] = [];
		const validEntries: AccountRecord[] = [];
		for (const entry of source.accountsSource) {
			const normalized = normalizeAccountRecord(entry, now);
			if (!normalized) {
				corruptEntries.push(entry);
				continue;
			}
			if (!hasCompleteIdentity(normalized)) {
				legacyEntries.push(normalized);
				continue;
			}
			validEntries.push(normalized);
		}
		if (corruptEntries.length > 0 || legacyEntries.length > 0) {
			return {
				status: "needs-repair",
				corruptEntries,
				legacyEntries,
				validEntries,
			};
		}
		return { status: "ok", corruptEntries: [], legacyEntries: [], validEntries };
	} catch {
		return {
			status: "corrupt-file",
			reason: "parse-error",
			corruptEntries: [],
			legacyEntries: [],
			validEntries: [],
		};
	}
}

async function writeAccountsFile(storage: AccountStorageV3): Promise<void> {
	await saveAccountsWithLock(() => storage);
}

export async function writeQuarantineFile(
	records: unknown[],
	reason: string,
): Promise<string> {
	const filePath = getStoragePath();
	const quarantinePath = `${filePath}.quarantine-${Date.now()}.json`;
	await fs.mkdir(dirname(filePath), { recursive: true });
	const payload = {
		reason,
		quarantinedAt: new Date().toISOString(),
		records,
	};
	const content = JSON.stringify(payload, null, 2);
	const tmpPath = `${quarantinePath}.${randomBytes(6).toString("hex")}.tmp`;

	try {
		await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		await fs.rename(tmpPath, quarantinePath);
	} catch (error) {
		await fs.unlink(tmpPath).catch(() => undefined);
		throw error;
	}

	await cleanupQuarantineFiles(filePath);
	return quarantinePath;
}

export async function replaceAccountsFile(storage: AccountStorageV3): Promise<void> {
	await writeAccountsFile(storage);
}

export async function quarantineCorruptFile(): Promise<string | null> {
	const filePath = getStoragePath();
	if (!existsSync(filePath)) return null;
	const quarantinePath = `${filePath}.quarantine-${Date.now()}.json`;
	await withFileLock(filePath, async () => {
		if (!existsSync(filePath)) return;
		const content = await fs.readFile(filePath);
		await fs.writeFile(quarantinePath, content, { mode: 0o600 });
		await cleanupQuarantineFiles(filePath);
	});
	await writeAccountsFile({
		version: 3,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {},
	});
	return quarantinePath;
}

export async function autoQuarantineCorruptAccountsFile(): Promise<string | null> {
	const inspection = await inspectAccountsFile();
	if (inspection.status !== "corrupt-file") return null;
	return await quarantineCorruptFile();
}

export async function quarantineAccounts(
	storage: AccountStorageV3,
	entries: AccountRecord[],
	reason: string,
): Promise<{ storage: AccountStorageV3; quarantinePath: string }> {
	if (!entries.length) {
		return { storage, quarantinePath: await writeQuarantineFile([], reason) };
	}
	const tokens = new Set(entries.map((entry) => entry.refreshToken));
	const remaining = storage.accounts.filter((account) => !tokens.has(account.refreshToken));
	const normalized = normalizeStorage({
		accounts: remaining,
		activeIndex: storage.activeIndex,
		activeIndexByFamily: storage.activeIndexByFamily,
	});
	const updated: AccountStorageV3 =
		normalized ?? {
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
	const quarantinePath = await writeQuarantineFile(entries, reason);
	await writeAccountsFile(updated);
	return { storage: updated, quarantinePath };
}

export async function loadAccounts(): Promise<AccountStorageV3 | null> {
	await migrateLegacyAccountsFileIfNeeded();
	const filePath = getStoragePath();
	debug(`[LoadAccounts] Loading from: ${filePath}`);
	try {
		if (!existsSync(filePath)) {
			debug(`[LoadAccounts] File does not exist: ${filePath}`);
			return null;
		}
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return normalizeStorage(parsed);
	} catch {
		return null;
	}
}

export function toggleAccountEnabled(
	storage: AccountStorageV3,
	index: number,
): AccountStorageV3 | null {
	if (!storage?.accounts) return null;
	if (!Number.isFinite(index)) return null;
	const targetIndex = Math.floor(index);
	if (targetIndex < 0 || targetIndex >= storage.accounts.length) return null;
	const accounts = storage.accounts.map((account, idx) => {
		if (idx !== targetIndex) return account;
		const enabled = account.enabled === false ? true : false;
		return { ...account, enabled };
	});
	return { ...storage, accounts };
}

export async function saveAccounts(
	storage: AccountStorageV3,
	options?: SaveAccountsOptions,
): Promise<void> {
	await saveAccountsWithLock((existing) => {
		return existing && !options?.replace
			? mergeAccountStorage(existing, storage, options)
			: storage;
	});
}
