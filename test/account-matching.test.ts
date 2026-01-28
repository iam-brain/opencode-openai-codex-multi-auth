import { describe, it, expect } from "vitest";

import { findAccountMatchIndex } from "../lib/account-matching.js";
import type { AccountRecordV3 } from "../lib/types.js";

const accounts: AccountRecordV3[] = [
	{
		refreshToken: "refresh-1",
		accountId: "acct-1",
		plan: "Plus",
		addedAt: 1,
		lastUsed: 1,
	},
	{
		refreshToken: "refresh-2",
		accountId: "acct-1",
		plan: "Team",
		addedAt: 2,
		lastUsed: 2,
	},
	{
		refreshToken: "refresh-3",
		accountId: "acct-2",
		plan: "Plus",
		addedAt: 3,
		lastUsed: 3,
	},
];

describe("account matching", () => {
	it("matches by accountId and plan when plan is present", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: "acct-1",
			plan: "Team",
		});
		expect(index).toBe(1);
	});

	it("does not match when plan differs", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: "acct-1",
			plan: "Pro",
		});
		expect(index).toBe(-1);
	});

	it("falls back to accountId when plan is missing", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: "acct-1",
		});
		expect(index).toBe(0);
	});
});
