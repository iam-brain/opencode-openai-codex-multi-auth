import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AccountStorageV3 } from "./types.js";

type AccountRecord = AccountStorageV3["accounts"][number];

type RateLimitState = Record<string, number | undefined>;

const STORAGE_FILE = "openai-codex-accounts.json";
const AUTH_DEBUG_ENABLED = process.env.OPENCODE_OPENAI_AUTH_DEBUG === "1";

function debug(...args: unknown[]): void {
	if (!AUTH_DEBUG_ENABLED) return;
	console.debug(...args);
}

function getOpencodeConfigDir(): string {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome && xdgConfigHome.trim()) {
		return join(xdgConfigHome, "opencode");
	}
	return join(homedir(), ".config", "opencode");
}

function getLegacyOpencodeDir(): string {
	return join(homedir(), ".opencode");
}

export function getStoragePath(): string {
	return join(getOpencodeConfigDir(), STORAGE_FILE);
}

function getLegacyStoragePath(): string {
	return join(getLegacyOpencodeDir(), STORAGE_FILE);
}

function normalizeStorage(parsed: unknown): AccountStorageV3 | null {
	const now = Date.now();

	const normalizeAccountRecord = (candidate: unknown): AccountRecord | null => {
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
		const plan = typeof planRaw === "string" && planRaw.trim() ? planRaw : undefined;

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
	};

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
	const accounts = accountsSource
		.map(normalizeAccountRecord)
		.filter((a): a is AccountRecord => a !== null);
	if (accounts.length === 0) return null;

	const activeIndex =
		typeof activeIndexSource === "number" && Number.isFinite(activeIndexSource)
			? Math.max(0, Math.floor(activeIndexSource))
			: 0;
	const clampedActiveIndex =
		accounts.length > 0 ? Math.min(activeIndex, accounts.length - 1) : 0;

	const activeIndexByFamily =
		activeIndexByFamilySource && typeof activeIndexByFamilySource === "object"
			? (activeIndexByFamilySource as AccountStorageV3["activeIndexByFamily"])
			: {};

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

function findAccountMatchIndex(accounts: AccountRecord[], candidate: AccountRecord): number {
	if (candidate.accountId) {
		const matchIndex = accounts.findIndex((account) => account.accountId === candidate.accountId);
		if (matchIndex >= 0) return matchIndex;
	}
	if (candidate.email) {
		const matchIndex = accounts.findIndex((account) => account.email === candidate.email);
		if (matchIndex >= 0) return matchIndex;
	}
	if (candidate.refreshToken) {
		return accounts.findIndex((account) => account.refreshToken === candidate.refreshToken);
	}
	return -1;
}

function mergeAccounts(
	existing: AccountRecord[],
	incoming: AccountRecord[],
): { accounts: AccountRecord[]; changed: boolean } {
	const merged = existing.map((account) => ({ ...account }));
	let changed = false;

	for (const candidate of incoming) {
		const matchIndex = findAccountMatchIndex(merged, candidate);
		if (matchIndex < 0) {
			merged.push({ ...candidate });
			changed = true;
			continue;
		}

		const current = merged[matchIndex];
		const updated = { ...current };
		let didUpdate = false;

		if (!updated.refreshToken && candidate.refreshToken) {
			updated.refreshToken = candidate.refreshToken;
			didUpdate = true;
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
			const mergedRateLimits = {
				...candidate.rateLimitResetTimes,
				...updated.rateLimitResetTimes,
			};
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

	return { accounts: merged, changed };
}

async function migrateLegacyAccountsFileIfNeeded(): Promise<void> {
	const newPath = getStoragePath();
	const legacyPath = getLegacyStoragePath();
	const newExists = existsSync(newPath);
	const legacyExists = existsSync(legacyPath);

	if (!legacyExists) return;

	if (!newExists) {
		await fs.mkdir(dirname(newPath), { recursive: true });
		try {
			await fs.rename(legacyPath, newPath);
		} catch {
			try {
				await fs.copyFile(legacyPath, newPath);
				await fs.unlink(legacyPath);
			} catch {
				// Best-effort; ignore.
			}
		}
		return;
	}

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
			await fs.writeFile(newPath, JSON.stringify(legacyStorage, null, 2), "utf-8");
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
		await fs.writeFile(newPath, JSON.stringify(mergedStorage, null, 2), "utf-8");

		try {
			await fs.unlink(legacyPath);
		} catch {
			// Best-effort; ignore.
		}
	} catch {
		// Best-effort; ignore.
	}
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

export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
	const filePath = getStoragePath();
	debug(`[SaveAccounts] Saving to ${filePath} with ${storage.accounts.length} accounts`);

	try {
		await fs.mkdir(dirname(filePath), { recursive: true });
		const jsonContent = JSON.stringify(storage, null, 2);
		debug(`[SaveAccounts] Writing ${jsonContent.length} bytes`);
		const tmpPath = `${filePath}.tmp`;
		await fs.writeFile(tmpPath, jsonContent, "utf-8");
		await fs.rename(tmpPath, filePath);

		if (AUTH_DEBUG_ENABLED) {
			const verifyContent = await fs.readFile(filePath, "utf-8");
			const verifyStorage = normalizeStorage(JSON.parse(verifyContent));
			if (verifyStorage) {
				debug(
					`[SaveAccounts] Verification successful - ${verifyStorage.accounts.length} accounts in file`,
				);
			} else {
				debug("[SaveAccounts] Verification failed - invalid storage format");
			}
		}
	} catch (error) {
		console.error("[SaveAccounts] Error saving accounts:", error);
		throw error;
	}
}
