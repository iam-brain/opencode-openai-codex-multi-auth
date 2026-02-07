import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
	buildAuthMenuItems,
	buildAccountActionItems,
	buildAccountSelectItems,
	formatLastUsedHint,
	getAccountBadge,
} from "../lib/ui/auth-menu.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as {
	accounts: Array<{
		accountId: string;
		email: string;
		plan: string;
		refreshToken: string;
		lastUsed: number;
		enabled?: boolean;
		rateLimitResetTimes?: Record<string, number>;
	}>;
};

describe("auth menu helpers", () => {
	it("formats last-used hints", () => {
		const now = Date.now();
		expect(formatLastUsedHint(now, now)).toBe("used today");
		expect(formatLastUsedHint(now - 24 * 60 * 60 * 1000, now)).toBe("used yesterday");
		expect(formatLastUsedHint(now - 3 * 24 * 60 * 60 * 1000, now)).toBe("used 3d ago");
		expect(formatLastUsedHint(0, now)).toBe("");
	});

	it("builds badges for status", () => {
		const now = fixture.accounts[0]!.lastUsed;
		expect(getAccountBadge({ enabled: false }, now)).toBe("[disabled]");
		expect(getAccountBadge({ enabled: true, isActive: true }, now)).toBe("[active]");
		expect(
			getAccountBadge(
				{
					enabled: true,
					rateLimitResetTimes: { codex: now + 60_000 },
				},
				now,
			),
		).toBe("[rate-limited]");
	});

	it("builds auth menu items with account labels", () => {
		const account = fixture.accounts[0]!;
		const now = account.lastUsed;
		const items = buildAuthMenuItems(
			[
				{
					index: 0,
					email: account.email,
					plan: account.plan,
					accountId: account.accountId,
					lastUsed: account.lastUsed,
					isActive: true,
				},
			],
			now,
		);

		expect(items[0]?.label).toBe("Add new account");
		expect(items[1]?.label).toBe("Check quotas");
		const accountItem = items.find((item) => item.label.includes(account.email));
		expect(accountItem).toBeTruthy();
		expect(accountItem!.label).toContain("[active]");
		expect(accountItem!.hint).toBe("used today");
	});

	it("builds account actions and hides refresh when disabled", () => {
		const account = fixture.accounts[0]!;
		const enabled = buildAccountActionItems({
			index: 0,
			email: account.email,
			plan: account.plan,
			enabled: true,
		});
		expect(enabled.map((item) => item.label)).toContain("Disable account");
		expect(enabled.map((item) => item.label)).toContain("Refresh token");

		const disabled = buildAccountActionItems({
			index: 0,
			email: account.email,
			plan: account.plan,
			enabled: false,
		});
		expect(disabled.map((item) => item.label)).toContain("Enable account");
		expect(disabled.map((item) => item.label)).not.toContain("Refresh token");
	});

	it("builds account-only select items", () => {
		const account = fixture.accounts[0]!;
		const now = account.lastUsed;
		const items = buildAccountSelectItems(
			[
				{
					index: 0,
					email: account.email,
					plan: account.plan,
					accountId: account.accountId,
					lastUsed: account.lastUsed,
					isActive: true,
				},
			],
			now,
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.label).toContain(account.email);
		expect(items[0]?.label).toContain("[active]");
		expect(items[0]?.hint).toBe("used today");
	});
});
