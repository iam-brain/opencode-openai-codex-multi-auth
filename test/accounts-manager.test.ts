import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountManager } from "../lib/accounts.js";
import { JWT_CLAIM_PATH } from "../lib/constants.js";
import { loadAccounts, saveAccounts } from "../lib/storage.js";
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

function createJwt(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64");
	return `${header}.${payload}.sig`;
}

function createStorage(count: number): AccountStorageV3 {
	const now = Date.now();
	return {
		version: 3,
		accounts: Array.from({ length: count }, (_, idx) => ({
			refreshToken: `refresh-${idx}`,
			accountId: `acct-${idx}`,
			addedAt: now,
			lastUsed: 0,
		})),
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
			const initialStorage: AccountStorageV3 = {
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-0",
						accountId: "acct-0",
						plan: "Plus",
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			};
			await saveAccounts(initialStorage);

			const manager = await AccountManager.loadFromDisk(createAuth("refresh-0"));

			const expandedStorage: AccountStorageV3 = {
				...initialStorage,
				accounts: [
					...initialStorage.accounts,
					{
						refreshToken: "refresh-1",
						accountId: "acct-1",
						plan: "Team",
						addedAt: 2,
						lastUsed: 2,
					},
				],
			};
			await saveAccounts(expandedStorage);

			await manager.saveToDisk();
			const finalStorage = await loadAccounts();

			expect(finalStorage?.accounts.length).toBe(2);
			expect(finalStorage?.accounts.some((a) => a.accountId === "acct-1")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves plan-specific entries when fallback matches accountId", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-accounts-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const storage: AccountStorageV3 = {
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-plus",
						accountId: "acct-dup",
						plan: "Plus",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						refreshToken: "refresh-team",
						accountId: "acct-dup",
						plan: "Team",
						addedAt: 2,
						lastUsed: 2,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			};
			await saveAccounts(storage);

			const access = createJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: "acct-dup",
					chatgpt_plan_type: "plus",
					email: "user@example.com",
				},
			});
			const manager = await AccountManager.loadFromDisk(
				createAuth("refresh-fallback", access),
			);
			const snapshot = manager.getAccountsSnapshot();
			const plus = snapshot.find((account) => account.plan === "Plus");
			const team = snapshot.find((account) => account.plan === "Team");

			expect(plus?.refreshToken).toBe("refresh-fallback");
			expect(team?.refreshToken).toBe("refresh-team");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("applies PID offset once in sticky mode", () => {
		const manager = new AccountManager(createAuth("refresh-0"), createStorage(3));

		const first = manager.getCurrentOrNextForFamily(family, null, "sticky", true);
		expect(first?.index).toBe(1);

		const second = manager.getCurrentOrNextForFamily(family, null, "sticky", true);
		expect(second?.index).toBe(1);
	});

	it("round-robin rotates accounts each call", () => {
		const manager = new AccountManager(createAuth("refresh-0"), createStorage(3));

		const first = manager.getCurrentOrNextForFamily(family, null, "round-robin", true);
		const second = manager.getCurrentOrNextForFamily(family, null, "round-robin", true);
		const third = manager.getCurrentOrNextForFamily(family, null, "round-robin", true);

		expect([first?.index, second?.index, third?.index]).toEqual([1, 2, 0]);
	});

	it("skips rate-limited current account in sticky mode", () => {
		const manager = new AccountManager(createAuth("refresh-0"), createStorage(2));
		const first = manager.getCurrentOrNextForFamily(family, null, "sticky", false);
		expect(first?.index).toBe(0);

		if (!first) throw new Error("Expected account");
		manager.markRateLimited(first, 60_000, family);

		const next = manager.getCurrentOrNextForFamily(family, null, "sticky", false);
		expect(next?.index).toBe(1);
	});

	it("does not duplicate rate-limit keys when model matches family", () => {
		const manager = new AccountManager(createAuth("refresh-0"), createStorage(1));
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
