import { formatAccountLabel } from "../accounts.js";
import type { RateLimitStateV3 } from "../types.js";
import type { SelectItem } from "./tty/select.js";

export type AuthMenuAction =
	| { type: "add" }
	| { type: "check-quotas" }
	| { type: "manage" }
	| { type: "configure-models" }
	| { type: "select-account"; account: AuthMenuAccount }
	| { type: "delete-all" };

export type AccountAction = "back" | "toggle" | "refresh" | "delete";

export type AuthMenuAccount = {
	index: number;
	email?: string;
	plan?: string;
	accountId?: string;
	enabled?: boolean;
	lastUsed?: number;
	rateLimitResetTimes?: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: "auth-failure";
	isActive?: boolean;
};

export function formatLastUsedHint(lastUsed: number | undefined, now = Date.now()): string {
	if (!lastUsed || !Number.isFinite(lastUsed) || lastUsed <= 0) return "";
	const diff = Math.max(0, now - lastUsed);
	const dayMs = 24 * 60 * 60 * 1000;
	if (diff < dayMs) return "used today";
	if (diff < 2 * dayMs) return "used yesterday";
	const days = Math.floor(diff / dayMs);
	return `used ${days}d ago`;
}

function isRateLimited(rateLimitResetTimes: RateLimitStateV3 | undefined, now: number): boolean {
	if (!rateLimitResetTimes) return false;
	return Object.values(rateLimitResetTimes).some((resetAt) =>
		typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > now,
	);
}

export function getAccountBadge(account: AuthMenuAccount, now = Date.now()): string {
	if (account.enabled === false) return "[disabled]";
	if (isRateLimited(account.rateLimitResetTimes, now)) return "[rate-limited]";
	if (account.isActive) return "[active]";
	return "";
}

export function buildAuthMenuItems(
	accounts: AuthMenuAccount[],
	now = Date.now(),
): Array<SelectItem<AuthMenuAction>> {
	const items: Array<SelectItem<AuthMenuAction>> = [
		{ label: "Add new account", value: { type: "add" } },
		{ label: "Check quotas", value: { type: "check-quotas" } },
		{ label: "Manage accounts (enable/disable)", value: { type: "manage" } },
		{ label: "Configure models in opencode.json", value: { type: "configure-models" } },
	];

	for (const account of accounts) {
		const baseLabel = formatAccountLabel(
			{ email: account.email, plan: account.plan, accountId: account.accountId },
			account.index,
		);
		const badge = getAccountBadge(account, now);
		const label = badge ? `${baseLabel} ${badge}` : baseLabel;
		const hint = formatLastUsedHint(account.lastUsed, now);
		items.push({
			label,
			hint: hint || undefined,
			value: { type: "select-account", account },
		});
	}

	if (accounts.length > 0) {
		items.push({ label: "Delete all accounts", value: { type: "delete-all" } });
	}

	return items;
}

export function buildAccountActionItems(
	account: AuthMenuAccount,
): Array<SelectItem<AccountAction>> {
	const items: Array<SelectItem<AccountAction>> = [
		{ label: "Back", value: "back" },
		{
			label: account.enabled === false ? "Enable account" : "Disable account",
			value: "toggle",
		},
	];

	if (account.enabled !== false) {
		items.push({ label: "Refresh token", value: "refresh" });
	}

	items.push({ label: "Delete this account", value: "delete" });
	return items;
}

export function buildAccountSelectItems(
	accounts: AuthMenuAccount[],
	now = Date.now(),
): Array<SelectItem<AuthMenuAccount>> {
	return accounts.map((account) => {
		const baseLabel = formatAccountLabel(
			{ email: account.email, plan: account.plan, accountId: account.accountId },
			account.index,
		);
		const badge = getAccountBadge(account, now);
		const label = badge ? `${baseLabel} ${badge}` : baseLabel;
		const hint = formatLastUsedHint(account.lastUsed, now);
		return {
			label,
			hint: hint || undefined,
			value: account,
		};
	});
}
