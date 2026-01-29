import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";

import { findAccountMatchIndex } from "../lib/account-matching.js";
import type { AccountRecordV3, AccountStorageV3 } from "../lib/types.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as AccountStorageV3;
const accounts = fixture.accounts as AccountRecordV3[];
const accountOne = accounts[0]!;
const accountTwo = accounts[1]!;
const accountThree = accounts[2]!;

describe("account matching", () => {
	it("matches by accountId, plan, and email", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: accountThree.accountId,
			plan: accountThree.plan,
			email: accountThree.email,
		});
		expect(index).toBe(2);
	});

	it("does not match when email differs", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: accountTwo.accountId,
			plan: accountTwo.plan,
			email: "other@example.com",
		});
		expect(index).toBe(-1);
	});

	it("returns -1 when plan is missing", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: accountTwo.accountId,
		});
		expect(index).toBe(-1);
	});

	it("returns -1 when plan is missing even if unique", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: accountOne.accountId,
			email: accountOne.email,
		});
		expect(index).toBe(-1);
	});

	it("returns -1 when email is missing", () => {
		const index = findAccountMatchIndex(accounts, {
			accountId: accountOne.accountId,
			plan: accountOne.plan,
		});
		expect(index).toBe(-1);
	});
});
