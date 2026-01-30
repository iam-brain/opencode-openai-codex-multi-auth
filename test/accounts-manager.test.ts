import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	copyFileSync,
	mkdtempSync,
	rmSync,
	readFileSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import * as authModule from "../lib/auth/auth.js";
import { createJwt } from "./helpers/jwt.js";
import { JWT_CLAIM_PATH } from "../lib/constants.js";
import { getStoragePath, loadAccounts, saveAccounts } from "../lib/storage.js";
import type { AccountStorageV3, OAuthAuthDetails } from "../lib/types.js";
import type { ModelFamily } from "../lib/prompts/codex.js";

function createAuth(refresh: string, access = "access"): OAuthAuthDetails {
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + 60_000,
	};
}

function loadFixture(fileName: string): AccountStorageV3 {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), "utf-8"),
	) as AccountStorageV3;
}

type HydrationFixture = {
	tokens: Array<{
		refreshToken: string;
		accessPayload: Record<string, unknown>;
		idPayload: Record<string, unknown>;
	}>;
};

const fixture = loadFixture("openai-codex-accounts.json");
const fixtureAccounts = fixture.accounts;
const backupFixtureUrl = new URL(
	"./fixtures/backup/openai-codex-accounts.backup.json",
	import.meta.url,
);

function seedStorageFromBackup(root: string): AccountStorageV3 {
	const storagePath = join(root, "opencode", "openai-codex-accounts.json");
	mkdirSync(join(root, "opencode"), { recursive: true });
	copyFileSync(backupFixtureUrl, storagePath);
	return JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
}

function createStorage(count: number): AccountStorageV3 {
	const accounts = fixtureAccounts.slice(0, count).map((account) => ({
		...account,
		rateLimitResetTimes: account.rateLimitResetTimes
			? { ...account.rateLimitResetTimes }
			: undefined,
	}));
	return {
		version: 3,
		accounts,
		activeIndex: 0,
		activeIndexByFamily: {
			codex: 0,
		},
	};
}

describe("AccountManager", () => {
	const family: ModelFamily = "codex";
	const originalPid = process.pid;
	const originalXdg = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
		Object.defineProperty(process, "pid", {
			value: originalPid,
			writable: false,
			enumerable: true,
			configurable: true,
		});
	});

	beforeEach(() => {
		Object.defineProperty(process, "pid", {
			value: 1,
			writable: false,
			enumerable: true,
			configurable: true,
		});
	});

	it("merge saveToDisk with latest storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			seedStorageFromBackup(root);
			const fixture = loadFixture("openai-codex-accounts.json");
			const accountOne = fixture.accounts[0]!;
			const accountTwo = fixture.accounts[1]!;
			const initialStorage: AccountStorageV3 = {
				...fixture,
				accounts: [accountOne],
			};
			writeFileSync(
				getStoragePath(),
				JSON.stringify(initialStorage, null, 2),
				"utf-8",
			);

			const manager = await AccountManager.loadFromDisk(createAuth(accountOne.refreshToken));

			const expandedStorage: AccountStorageV3 = {
				...fixture,
				accounts: [accountOne, accountTwo],
			};
			await saveAccounts(expandedStorage);

			await manager.saveToDisk();
			const finalStorage = await loadAccounts();

			expect(finalStorage?.accounts.length).toBe(2);
			expect(
				finalStorage?.accounts.some((a) => a.accountId === accountTwo.accountId),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("updates lastUsed only when marked used", () => {
		const manager = new AccountManager(
			createAuth(fixtureAccounts[0]!.refreshToken),
			createStorage(1),
		);
		const account = manager.getCurrentOrNextForFamily("codex", null, "sticky", false);
		if (!account) throw new Error("Expected account");
		const originalLastUsed = account.lastUsed;

		manager.markAccountUsed(account.index);
		expect(account.lastUsed).toBeGreaterThanOrEqual(originalLastUsed);
	});

	it("dedupes concurrent refresh for same account", async () => {
		const fixture = loadFixture("openai-codex-accounts.json");
		const accountOne = fixture.accounts[0]!;
		const manager = new AccountManager(createAuth(accountOne.refreshToken), fixture);

		const account = manager.getCurrentOrNextForFamily("codex", null, "sticky", false);
		if (!account) throw new Error("Expected account");

		const refreshFn = vi.fn(async (token: string) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {
				type: "success" as const,
				access: "access",
				refresh: `${token}-new`,
				expires: Date.now() + 60_000,
			};
		});

		const [first, second] = await Promise.all([
			manager.refreshAccountWithLock(account, refreshFn),
			manager.refreshAccountWithLock(account, refreshFn),
		]);

		expect(refreshFn).toHaveBeenCalledTimes(1);
		expect(first.type).toBe("success");
		expect(second.type).toBe("success");
	});

	it("retries refresh when disk has newer token", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			seedStorageFromBackup(root);
			const fixture = loadFixture("openai-codex-accounts.json");
			const accountOne = fixture.accounts[0]!;
			const updatedToken = `${accountOne.refreshToken}-new`;

			await saveAccounts({ ...fixture, accounts: [accountOne] });
			const manager = await AccountManager.loadFromDisk(createAuth(accountOne.refreshToken));
			const account = manager.getCurrentOrNextForFamily("codex", null, "sticky", false);
			if (!account) throw new Error("Expected account");

			await saveAccounts({
				...fixture,
				accounts: [{ ...accountOne, refreshToken: updatedToken }],
			});

			const refreshFn = vi.fn(async (token: string) => {
				if (token === accountOne.refreshToken) {
					return { type: "failed" as const };
				}
				return {
					type: "success" as const,
					access: "access",
					refresh: token,
					expires: Date.now() + 60_000,
				};
			});

			const result = await manager.refreshAccountWithFallback(account, refreshFn);
			expect(result.type).toBe("success");
			expect(refreshFn).toHaveBeenCalledTimes(2);
			expect(refreshFn.mock.calls[1]?.[0]).toBe(updatedToken);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("migrates legacy accounts and writes a backup", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const base = seedStorageFromBackup(root);
			const original = base.accounts[0]!;
			const legacy = {
				...original,
				email: undefined,
				plan: undefined,
			};
			const storagePath = getStoragePath();
			writeFileSync(
				storagePath,
				JSON.stringify(
					{
						...base,
						accounts: [legacy, ...base.accounts.slice(1)],
					},
					null,
					2,
				),
				"utf-8",
			);

			const hydration = JSON.parse(
				readFileSync(new URL("./fixtures/oauth-hydration.json", import.meta.url), "utf-8"),
			) as HydrationFixture;
			const tokenEntry = hydration.tokens.find(
				(entry) => entry.refreshToken === original.refreshToken,
			);
			if (!tokenEntry) throw new Error("Missing hydration fixture");
			const idToken = createJwt(tokenEntry.idPayload);
			const refreshSpy = vi
				.spyOn(authModule, "refreshAccessToken")
				.mockResolvedValue({
					type: "success",
					access: "access",
					refresh: `${original.refreshToken}-new`,
					expires: Date.now() + 60_000,
					idToken,
				});

			await AccountManager.loadFromDisk();

			const migrated = await loadAccounts();
			const updated = migrated?.accounts.find(
				(account) => account.refreshToken === `${original.refreshToken}-new`,
			);
			expect(updated?.accountId).toBe(original.accountId);
			expect(updated?.email).toBe(original.email);
			expect(updated?.plan).toBe(original.plan);
			expect(refreshSpy).toHaveBeenCalledTimes(1);

			const backups = readdirSync(join(root, "opencode")).filter((name) =>
				name.startsWith("openai-codex-accounts.json.bak-"),
			);
			expect(backups).toHaveLength(1);
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates missing emails with a backup", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const legacy = {
				...base.accounts[0]!,
				email: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			const refreshSpy = vi
				.spyOn(authModule, "refreshAccessToken")
				.mockResolvedValue({ type: "failed" });

			const manager = new AccountManager(undefined, storage);
			await manager.hydrateMissingEmails();

			const backups = readdirSync(join(root, "opencode")).filter((name) =>
				name.startsWith("openai-codex-accounts.json.bak-"),
			);
			expect(backups).toHaveLength(1);
			expect(refreshSpy).toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates missing plan when email and accountId present", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const original = base.accounts[0]!;
			const legacy = {
				...original,
				plan: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			const hydration = JSON.parse(
				readFileSync(new URL("./fixtures/oauth-hydration.json", import.meta.url), "utf-8"),
			) as HydrationFixture;
			const tokenEntry = hydration.tokens.find(
				(entry) => entry.refreshToken === original.refreshToken,
			);
			if (!tokenEntry) throw new Error("Missing hydration fixture");
			const idToken = createJwt(tokenEntry.idPayload);
			const refreshSpy = vi
				.spyOn(authModule, "refreshAccessToken")
				.mockResolvedValue({
					type: "success",
					access: "access",
					refresh: `${original.refreshToken}-new`,
					expires: Date.now() + 60_000,
					idToken,
				});

			const manager = new AccountManager(undefined, storage);
			await manager.hydrateMissingEmails();

			const updated = manager.getAccountsSnapshot().find(
				(account) => account.refreshToken === `${original.refreshToken}-new`,
			);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(updated?.plan).toBe(original.plan);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates plan from access token when id token missing claim", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const original = base.accounts[0]!;
			const legacy = {
				...original,
				plan: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			const hydration = JSON.parse(
				readFileSync(new URL("./fixtures/oauth-hydration.json", import.meta.url), "utf-8"),
			) as HydrationFixture;
			const tokenEntry = hydration.tokens.find(
				(entry) => entry.refreshToken === original.refreshToken,
			);
			if (!tokenEntry) throw new Error("Missing hydration fixture");
			const idPayload = {
				...tokenEntry.idPayload,
				[JWT_CLAIM_PATH]: {
					...(tokenEntry.idPayload[JWT_CLAIM_PATH] as Record<string, unknown>),
					chatgpt_plan_type: undefined,
				},
			};
			const idToken = createJwt(idPayload);
			const accessToken = createJwt(tokenEntry.accessPayload);
			const refreshSpy = vi
				.spyOn(authModule, "refreshAccessToken")
				.mockResolvedValue({
					type: "success",
					access: accessToken,
					refresh: `${original.refreshToken}-new`,
					expires: Date.now() + 60_000,
					idToken,
				});

			const manager = new AccountManager(undefined, storage);
			await manager.hydrateMissingEmails();

			const updated = manager.getAccountsSnapshot().find(
				(account) => account.refreshToken === `${original.refreshToken}-new`,
			);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(updated?.plan).toBe(original.plan);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("hydrates email and accountId from access token when id token missing claims", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const original = base.accounts[0]!;
			const legacy = {
				...original,
				email: undefined,
				accountId: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			const hydration = JSON.parse(
				readFileSync(new URL("./fixtures/oauth-hydration.json", import.meta.url), "utf-8"),
			) as HydrationFixture;
			const tokenEntry = hydration.tokens.find(
				(entry) => entry.refreshToken === original.refreshToken,
			);
			if (!tokenEntry) throw new Error("Missing hydration fixture");
			const idPayload = {
				...tokenEntry.idPayload,
				email: undefined,
				preferred_username: undefined,
				[JWT_CLAIM_PATH]: {
					...(tokenEntry.idPayload[JWT_CLAIM_PATH] as Record<string, unknown>),
					chatgpt_account_id: undefined,
					email: undefined,
					chatgpt_user_email: undefined,
				},
			};
			const idToken = createJwt(idPayload);
			const accessToken = createJwt(tokenEntry.accessPayload);
			const refreshSpy = vi
				.spyOn(authModule, "refreshAccessToken")
				.mockResolvedValue({
					type: "success",
					access: accessToken,
					refresh: `${original.refreshToken}-new`,
					expires: Date.now() + 60_000,
					idToken,
				});

			const manager = new AccountManager(undefined, storage);
			await manager.hydrateMissingEmails();

			const updated = manager.getAccountsSnapshot().find(
				(account) => account.refreshToken === `${original.refreshToken}-new`,
			);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(updated?.email).toBe(original.email);
			expect(updated?.accountId).toBe(original.accountId);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairLegacyAccounts quarantines failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const legacy = {
				...base.accounts[0]!,
				plan: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			vi.spyOn(authModule, "refreshAccessToken").mockResolvedValue({ type: "failed" });

			const manager = new AccountManager(undefined, storage);
			const result = await manager.repairLegacyAccounts();

			expect(result.repaired).toHaveLength(0);
			expect(result.quarantined).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairLegacyAccounts fills missing identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const original = base.accounts[0]!;
			const legacy = {
				...original,
				plan: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			const hydration = JSON.parse(
				readFileSync(new URL("./fixtures/oauth-hydration.json", import.meta.url), "utf-8"),
			) as HydrationFixture;
			const tokenEntry = hydration.tokens.find(
				(entry) => entry.refreshToken === original.refreshToken,
			);
			if (!tokenEntry) throw new Error("Missing hydration fixture");
			const idToken = createJwt(tokenEntry.idPayload);
			vi.spyOn(authModule, "refreshAccessToken").mockResolvedValue({
				type: "success",
				access: "access",
				refresh: `${original.refreshToken}-new`,
				expires: Date.now() + 60_000,
				idToken,
			});

			const manager = new AccountManager(undefined, storage);
			const result = await manager.repairLegacyAccounts();

			expect(result.repaired).toHaveLength(1);
			expect(result.quarantined).toHaveLength(0);
			expect(result.repaired[0]?.plan).toBe(original.plan);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairLegacyAccounts quarantines when refreshed accountId conflicts", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const original = base.accounts[0]!;
			const legacy = {
				...original,
				plan: undefined,
			};
			const storage: AccountStorageV3 = {
				...base,
				accounts: [legacy, ...base.accounts.slice(1)],
			};
			const hydration = JSON.parse(
				readFileSync(new URL("./fixtures/oauth-hydration.json", import.meta.url), "utf-8"),
			) as HydrationFixture;
			const wrongTokenEntry = hydration.tokens.find(
				(entry) => entry.refreshToken === base.accounts[1]!.refreshToken,
			);
			if (!wrongTokenEntry) throw new Error("Missing hydration fixture");
			const wrongIdToken = createJwt(wrongTokenEntry.idPayload);
			vi.spyOn(authModule, "refreshAccessToken").mockResolvedValue({
				type: "success",
				access: "access",
				refresh: `${original.refreshToken}-new`,
				expires: Date.now() + 60_000,
				idToken: wrongIdToken,
			});

			const manager = new AccountManager(undefined, storage);
			const result = await manager.repairLegacyAccounts();

			expect(result.repaired).toHaveLength(0);
			expect(result.quarantined).toHaveLength(1);
			// Ensure the quarantined entry corresponds to the legacy record.
			expect(result.quarantined[0]?.refreshToken).toBe(original.refreshToken);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("getLegacyAccounts ignores disabled accounts", () => {
		const storage = createStorage(2);
		storage.accounts[0] = {
			...storage.accounts[0]!,
			enabled: false,
			email: undefined,
			plan: undefined,
		};
		storage.accounts[1] = {
			...storage.accounts[1]!,
			email: undefined,
			plan: undefined,
		};
		const manager = new AccountManager(
			createAuth(storage.accounts[0]!.refreshToken),
			storage,
		);
		const legacy = manager.getLegacyAccounts();
		expect(legacy).toHaveLength(1);
		expect(legacy[0]?.refreshToken).toBe(storage.accounts[1]!.refreshToken);
	});

	it("keeps legacy accounts but skips them for selection", () => {
		const legacyStorage: AccountStorageV3 = {
			...fixture,
			accounts: [
				{
					...fixtureAccounts[0]!,
					email: undefined,
					plan: undefined,
				},
				fixtureAccounts[1]!,
				fixtureAccounts[2]!,
			],
		};
		const manager = new AccountManager(undefined, legacyStorage);
		const snapshot = manager.getAccountsSnapshot();
		expect(snapshot).toHaveLength(3);

		const selected = manager.getCurrentOrNextForFamily("codex", null, "sticky", false);
		expect(selected?.accountId).toBe(fixtureAccounts[1]!.accountId);
	});

	it("getAccountCount ignores legacy accounts missing identity", () => {
		const legacyStorage: AccountStorageV3 = {
			...fixture,
			accounts: [
				{
					...fixtureAccounts[0]!,
					email: undefined,
					plan: undefined,
				},
				fixtureAccounts[1]!,
			],
		};
		const manager = new AccountManager(undefined, legacyStorage);
		expect(manager.getAccountCount()).toBe(1);
	});

	it("skips disabled accounts for selection", () => {
		const storage: AccountStorageV3 = {
			...fixture,
			accounts: [
				{ ...fixtureAccounts[0]!, enabled: false },
				fixtureAccounts[1]!,
				fixtureAccounts[2]!,
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		const manager = new AccountManager(undefined, storage);
		const selected = manager.getCurrentOrNextForFamily("codex", null, "sticky", false);
		expect(selected?.accountId).toBe(fixtureAccounts[1]!.accountId);
	});

	it("preserves enabled flag when saveToDisk falls back to snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const account = { ...fixtureAccounts[0]!, enabled: false };
			const storage: AccountStorageV3 = {
				version: 3,
				accounts: [account],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			};
			mkdirSync(join(root, "opencode"), { recursive: true });
			writeFileSync(getStoragePath(), "{", "utf-8");
			const manager = new AccountManager(createAuth(account.refreshToken), storage);
			await manager.saveToDisk();
			const saved = JSON.parse(readFileSync(getStoragePath(), "utf-8")) as AccountStorageV3;
			expect(saved.accounts[0]?.enabled).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults enabled to true when missing during saveToDisk", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const account = { ...fixtureAccounts[0]! };
			const storage: AccountStorageV3 = {
				version: 3,
				accounts: [account],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			};
			mkdirSync(join(root, "opencode"), { recursive: true });
			writeFileSync(getStoragePath(), "{", "utf-8");
			const manager = new AccountManager(createAuth(account.refreshToken), storage);
			await manager.saveToDisk();
			const saved = JSON.parse(readFileSync(getStoragePath(), "utf-8")) as AccountStorageV3;
			expect(saved.accounts[0]?.enabled).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves plan-specific entries when fallback matches accountId", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const accountPlus = base.accounts[0]!;
			const accountTeam = base.accounts[1]!;
			const storage: AccountStorageV3 = {
				...base,
				accounts: [accountPlus, accountTeam],
			};
			await saveAccounts(storage);

			const access = createJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: accountPlus.accountId,
					chatgpt_plan_type: "plus",
					email: accountPlus.email,
				},
			});
			const manager = await AccountManager.loadFromDisk(
				createAuth(accountPlus.refreshToken, access),
			);
			const snapshot = manager.getAccountsSnapshot();
			const plus = snapshot.find((account) => account.plan === "Plus");
			const team = snapshot.find((account) => account.plan === "Team");

			expect(plus?.refreshToken).toBe(accountPlus.refreshToken);
			expect(team?.refreshToken).toBe(accountTeam.refreshToken);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves email-specific entries when plan matches", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			seedStorageFromBackup(root);
			const fixture = loadFixture("openai-codex-accounts.json");
			const accountOne = fixture.accounts[1]!;
			const accountTwo = fixture.accounts[2]!;
			const storage: AccountStorageV3 = {
				...fixture,
				accounts: [accountOne, accountTwo],
			};
			await saveAccounts(storage);

			const access = createJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: accountOne.accountId,
					chatgpt_plan_type: "team",
					email: accountOne.email,
				},
			});
			const manager = await AccountManager.loadFromDisk(
				createAuth(accountOne.refreshToken, access),
			);
			const snapshot = manager.getAccountsSnapshot();
			const first = snapshot.find(
				(account) => account.email === accountOne.email && account.plan === accountOne.plan,
			);
			const second = snapshot.find(
				(account) => account.email === accountTwo.email && account.plan === accountTwo.plan,
			);

			expect(first?.refreshToken).toBe(accountOne.refreshToken);
			expect(second?.refreshToken).toBe(accountTwo.refreshToken);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips fallback account when plan is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const base = seedStorageFromBackup(root);
			const accountPlus = base.accounts[0]!;
			const accountTeam = base.accounts[1]!;
			const storage: AccountStorageV3 = {
				...base,
				accounts: [accountPlus, accountTeam],
			};
			await saveAccounts(storage);

			const access = createJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: accountPlus.accountId,
					email: accountPlus.email,
				},
			});
			const manager = await AccountManager.loadFromDisk(
				createAuth(accountPlus.refreshToken, access),
			);
			const snapshot = manager.getAccountsSnapshot();
			const plus = snapshot.find((account) => account.plan === "Plus");
			const team = snapshot.find((account) => account.plan === "Team");

			expect(snapshot).toHaveLength(3);
			expect(plus?.refreshToken).toBe(accountPlus.refreshToken);
			expect(team?.refreshToken).toBe(accountTeam.refreshToken);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("applies PID offset once in sticky mode", () => {
		const manager = new AccountManager(
			createAuth(fixtureAccounts[0]!.refreshToken),
			createStorage(3),
		);

		const first = manager.getCurrentOrNextForFamily(family, null, "sticky", true);
		expect(first?.index).toBe(1);

		const second = manager.getCurrentOrNextForFamily(family, null, "sticky", true);
		expect(second?.index).toBe(1);
	});

	it("round-robin rotates accounts each call", () => {
		const manager = new AccountManager(
			createAuth(fixtureAccounts[0]!.refreshToken),
			createStorage(3),
		);

		const first = manager.getCurrentOrNextForFamily(family, null, "round-robin", true);
		const second = manager.getCurrentOrNextForFamily(family, null, "round-robin", true);
		const third = manager.getCurrentOrNextForFamily(family, null, "round-robin", true);

		expect([first?.index, second?.index, third?.index]).toEqual([1, 2, 0]);
	});

	it("getAccountByIndex returns account references", () => {
		const manager = new AccountManager(
			createAuth(fixtureAccounts[0]!.refreshToken),
			createStorage(2),
		);
		const account = manager.getAccountByIndex(1);
		expect(account?.refreshToken).toBe(fixtureAccounts[1]!.refreshToken);
	});

	it("skips rate-limited current account in sticky mode", () => {
		const manager = new AccountManager(
			createAuth(fixtureAccounts[0]!.refreshToken),
			createStorage(2),
		);
		const first = manager.getCurrentOrNextForFamily(family, null, "sticky", false);
		expect(first?.index).toBe(0);

		if (!first) throw new Error("Expected account");
		manager.markRateLimited(first, 60_000, family);

		const next = manager.getCurrentOrNextForFamily(family, null, "sticky", false);
		expect(next?.index).toBe(1);
	});

	it("getMinWaitTimeForFamily ignores disabled accounts", () => {
		vi.useFakeTimers();
		try {
			const storage = createStorage(3);
			storage.accounts[0] = { ...storage.accounts[0]!, enabled: false };
			const now = Date.now();
			storage.accounts[1] = {
				...storage.accounts[1]!,
				rateLimitResetTimes: { codex: now + 10_000 },
			};
			storage.accounts[2] = {
				...storage.accounts[2]!,
				rateLimitResetTimes: { codex: now + 20_000 },
			};
			const manager = new AccountManager(
				createAuth(storage.accounts[0]!.refreshToken),
				storage,
			);
			const waitMs = manager.getMinWaitTimeForFamily(family, null);
			expect(waitMs).toBe(10_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("hydrates legacy accounts before calculating wait time", async () => {
		vi.useFakeTimers();
		try {
			const storage = createStorage(2);
			storage.accounts[0] = {
				...storage.accounts[0]!,
				email: undefined,
				accountId: undefined,
				plan: undefined,
			};
			const now = Date.now();
			storage.accounts[1] = {
				...storage.accounts[1]!,
				rateLimitResetTimes: { codex: now + 10_000 },
			};
			const manager = new AccountManager(
				createAuth(storage.accounts[0]!.refreshToken),
				storage,
			);
			const hydrateSpy = vi
				.spyOn(manager, "hydrateMissingEmails")
				.mockResolvedValue();
			const saveSpy = vi.spyOn(manager, "saveToDisk").mockResolvedValue();

			const waitMs = await manager.getMinWaitTimeForFamilyWithHydration(family, null);

			expect(hydrateSpy).toHaveBeenCalled();
			expect(saveSpy).toHaveBeenCalled();
			expect(waitMs).toBe(10_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips hydration for disabled legacy accounts", async () => {
		vi.useFakeTimers();
		try {
			const storage = createStorage(2);
			storage.accounts[0] = {
				...storage.accounts[0]!,
				enabled: false,
				email: undefined,
				accountId: undefined,
				plan: undefined,
			};
			const now = Date.now();
			storage.accounts[1] = {
				...storage.accounts[1]!,
				rateLimitResetTimes: { codex: now + 10_000 },
			};
			const manager = new AccountManager(
				createAuth(storage.accounts[0]!.refreshToken),
				storage,
			);
			const hydrateSpy = vi
				.spyOn(manager, "hydrateMissingEmails")
				.mockResolvedValue();
			const saveSpy = vi.spyOn(manager, "saveToDisk").mockResolvedValue();

			const waitMs = await manager.getMinWaitTimeForFamilyWithHydration(family, null);

			expect(hydrateSpy).not.toHaveBeenCalled();
			expect(saveSpy).not.toHaveBeenCalled();
			expect(waitMs).toBe(10_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("throttles repeated hydration attempts", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			const storage = createStorage(2);
			storage.accounts[0] = {
				...storage.accounts[0]!,
				email: undefined,
				accountId: undefined,
				plan: undefined,
			};
			const now = Date.now();
			storage.accounts[1] = {
				...storage.accounts[1]!,
				rateLimitResetTimes: { codex: now + 10_000 },
			};
			const manager = new AccountManager(
				createAuth(storage.accounts[0]!.refreshToken),
				storage,
			);
			const hydrateSpy = vi
				.spyOn(manager, "hydrateMissingEmails")
				.mockResolvedValue();
			const saveSpy = vi.spyOn(manager, "saveToDisk").mockResolvedValue();

			await manager.getMinWaitTimeForFamilyWithHydration(family, null);
			await manager.getMinWaitTimeForFamilyWithHydration(family, null);

			expect(hydrateSpy).toHaveBeenCalledTimes(1);
			expect(saveSpy).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(60_000);
			await manager.getMinWaitTimeForFamilyWithHydration(family, null);

			expect(hydrateSpy).toHaveBeenCalledTimes(2);
			expect(saveSpy).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not duplicate rate-limit keys when model matches family", () => {
		const manager = new AccountManager(
			createAuth(fixtureAccounts[0]!.refreshToken),
			createStorage(1),
		);
		const codexFamily: ModelFamily = "gpt-5.2-codex";

		const account = manager.getCurrentOrNextForFamily(
			codexFamily,
			codexFamily,
			"sticky",
			false,
		);
		if (!account) throw new Error("Expected account");

		manager.markRateLimited(account, 60_000, codexFamily, codexFamily);
		const keys = Object.keys(account.rateLimitResetTimes);
		expect(keys).toHaveLength(1);
		expect(keys[0]).toBe(codexFamily);
	});
});
