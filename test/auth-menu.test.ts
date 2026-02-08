import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
	buildAccountActionItems,
	buildAuthMenuItems,
	formatRelativeTime,
	formatStatusBadges,
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
	}>;
};

describe("auth menu helpers", () => {
	it("formats relative time labels", () => {
		const now = Date.now();
		expect(formatRelativeTime(now, now)).toBe("today");
		expect(formatRelativeTime(now - 24 * 60 * 60 * 1000, now)).toBe("yesterday");
		expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000, now)).toBe("3d ago");
	});

	it("builds status badges for enabled and active accounts", () => {
		const badges = formatStatusBadges(
			{
			enabled: true,
			status: "rate-limited",
			isCurrentAccount: true,
			},
			false,
		);
		expect(badges).toContain("[enabled]");
		expect(badges).toContain("[rate-limited]");
		expect(badges).toContain("[last active]");
	});

	it("builds status badges for disabled expired accounts", () => {
		const badges = formatStatusBadges(
			{
			enabled: false,
			status: "expired",
			},
			false,
		);
		expect(badges).toContain("[disabled]");
		expect(badges).toContain("[expired]");
	});

	it("builds auth menu items with account labels", () => {
		const account = fixture.accounts[0]!;
		const items = buildAuthMenuItems(
			[
			{
				index: 0,
				email: account.email,
				plan: account.plan,
				accountId: account.accountId,
				lastUsed: account.lastUsed,
				enabled: true,
				status: "active",
				isCurrentAccount: true,
			},
		],
		false,
	);

		const accountItem = items.find((item) => item.label.includes(account.email));
		expect(accountItem).toBeTruthy();
		expect(accountItem!.label).toContain("[enabled]");
		expect(accountItem!.label).toContain("[last active]");
		expect(accountItem!.hint).toContain("used");
	});

	it("does not show delete-all action when there are no accounts", () => {
		const items = buildAuthMenuItems([], false);
		expect(items.some((item) => item.value.type === "delete-all")).toBe(false);
	});

	it("disables refresh when account is disabled", () => {
		const account = fixture.accounts[0]!;
		const items = buildAccountActionItems({
			index: 0,
			email: account.email,
			plan: account.plan,
			enabled: false,
		});
		const refresh = items.find((item) => item.value === "refresh");
		expect(refresh?.disabled).toBe(true);
	});
});
