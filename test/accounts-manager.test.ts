import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import type { AccountStorageV3, OAuthAuthDetails } from "../lib/types.js";
import type { ModelFamily } from "../lib/prompts/codex.js";

function createAuth(refresh: string): OAuthAuthDetails {
	return {
		type: "oauth",
		access: "access",
		refresh,
		expires: Date.now() + 60_000,
	};
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

	afterEach(() => {
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
