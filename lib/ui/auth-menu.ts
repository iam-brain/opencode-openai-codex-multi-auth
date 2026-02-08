import { ANSI, shouldUseColor } from "./tty/ansi.js";
import { confirm } from "./tty/confirm.js";
import { select, type MenuItem } from "./tty/select.js";

export type AccountStatus = "active" | "rate-limited" | "expired" | "unknown";

export interface AccountInfo {
	email?: string;
	plan?: string;
	accountId?: string;
	index: number;
	addedAt?: number;
	lastUsed?: number;
	status?: AccountStatus;
	isCurrentAccount?: boolean;
	enabled?: boolean;
}

export type AuthMenuAction =
	| { type: "add" }
	| { type: "select-account"; account: AccountInfo }
	| { type: "delete-all" }
	| { type: "check" }
	| { type: "manage" }
	| { type: "configure-models" }
	| { type: "cancel" };

export type AccountAction = "back" | "delete" | "refresh" | "toggle" | "cancel";

export function formatRelativeTime(timestamp: number | undefined, now = Date.now()): string {
	if (!timestamp) return "never";
	const days = Math.floor((now - timestamp) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	return new Date(timestamp).toLocaleDateString();
}

function colorize(text: string, color: string, useColor: boolean): string {
	return useColor ? `${color}${text}${ANSI.reset}` : text;
}

function formatAccountDisplayName(account: AccountInfo): string {
	const base = account.email || `Account ${account.index + 1}`;
	const plan = typeof account.plan === "string" ? account.plan.trim() : "";
	return plan ? `${base} (${plan})` : base;
}

function getStatusBadge(status: AccountStatus | undefined, useColor: boolean): string {
	switch (status) {
		case "rate-limited":
			return colorize("[rate-limited]", ANSI.yellow, useColor);
		case "expired":
			return colorize("[expired]", ANSI.red, useColor);
		default:
			return "";
	}
}

export function formatStatusBadges(
	account: Pick<AccountInfo, "enabled" | "status" | "isCurrentAccount">,
	useColor = shouldUseColor(),
): string {
	const badges: string[] = [];
	if (account.enabled === false) {
		badges.push(colorize("[disabled]", ANSI.red, useColor));
	} else {
		badges.push(colorize("[enabled]", ANSI.green, useColor));
	}
	const statusBadge = getStatusBadge(account.status, useColor);
	if (statusBadge) badges.push(statusBadge);
	if (account.isCurrentAccount) {
		badges.push(colorize("[last active]", ANSI.cyan, useColor));
	}
	return badges.join(" ");
}

function buildAccountLabel(account: AccountInfo, useColor: boolean): string {
	const baseLabel = formatAccountDisplayName(account);
	const badges = formatStatusBadges(account, useColor);
	return badges ? `${baseLabel} ${badges}` : baseLabel;
}

export function buildAuthMenuItems(
	accounts: AccountInfo[],
	useColor = shouldUseColor(),
): MenuItem<AuthMenuAction>[] {
	const items: MenuItem<AuthMenuAction>[] = [
		{ label: "Add new account", value: { type: "add" } },
		{ label: "Check quotas", value: { type: "check" } },
		{ label: "Manage accounts (enable/disable)", value: { type: "manage" } },
		{ label: "Configure models in opencode.json", value: { type: "configure-models" } },

		...accounts.map((account) => {
			const label = buildAccountLabel(account, useColor);
			return {
				label,
				hint: account.lastUsed ? `used ${formatRelativeTime(account.lastUsed)}` : "",
				value: { type: "select-account" as const, account },
			};
		}),
	];
	if (accounts.length > 0) {
		items.push({ label: "Delete all accounts", value: { type: "delete-all" }, color: "red" });
	}

	return items;
}

export function buildAccountActionItems(
	account: AccountInfo,
): MenuItem<AccountAction>[] {
	return [
		{ label: "Back", value: "back" },
		{
			label: account.enabled === false ? "Enable account" : "Disable account",
			value: "toggle",
			color: account.enabled === false ? "green" : "yellow",
		},
		{
			label: "Refresh token",
			value: "refresh",
			color: "cyan",
			disabled: account.enabled === false,
		},
		{ label: "Delete this account", value: "delete", color: "red" },
	];
}

export function buildAccountSelectItems(
	accounts: AccountInfo[],
	useColor = shouldUseColor(),
): MenuItem<AccountInfo>[] {
	return accounts.map((account) => ({
		label: buildAccountLabel(account, useColor),
		hint: account.lastUsed ? `used ${formatRelativeTime(account.lastUsed)}` : "",
		value: account,
	}));
}

export async function selectAccount(
	accounts: AccountInfo[],
	options: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; useColor?: boolean } = {},
): Promise<AccountInfo | null> {
	const useColor = options.useColor ?? shouldUseColor();
	const items = buildAccountSelectItems(accounts, useColor);
	const result = await select(items, {
		message: "Manage accounts",
		subtitle: "Select account",
		input: options.input,
		output: options.output,
		useColor,
	});
	return result ?? null;
}

export async function showAuthMenu(
	accounts: AccountInfo[],
	options: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; useColor?: boolean } = {},
): Promise<AuthMenuAction> {
	const useColor = options.useColor ?? shouldUseColor();
	const items = buildAuthMenuItems(accounts, useColor);

	while (true) {
		const result = await select(items, {
			message: "Manage accounts",
			subtitle: "Select account",
			input: options.input,
			output: options.output,
			useColor,
		});

		if (!result) return { type: "cancel" };
		if (result.type === "delete-all") {
			const confirmed = await confirm(
				"Delete ALL accounts? This cannot be undone.",
				false,
				options,
			);
			if (!confirmed) continue;
		}

		return result;
	}
}

export async function showAccountDetails(
	account: AccountInfo,
	options: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; useColor?: boolean } = {},
): Promise<AccountAction> {
	const useColor = options.useColor ?? shouldUseColor();
	const output = options.output ?? process.stdout;
	const label = formatAccountDisplayName(account);
	const badges = formatStatusBadges(account, useColor);

	const bold = useColor ? ANSI.bold : "";
	const dim = useColor ? ANSI.dim : "";
	const reset = useColor ? ANSI.reset : "";

	output.write("\n");
	output.write(`${bold}Account: ${label}${badges ? ` ${badges}` : ""}${reset}\n`);
	output.write(`${dim}Added: ${formatDate(account.addedAt)}${reset}\n`);
	output.write(`${dim}Last used: ${formatRelativeTime(account.lastUsed)}${reset}\n`);
	output.write("\n");

	while (true) {
		const result = await select(buildAccountActionItems(account), {
			message: "Account options",
			subtitle: "Select action",
			input: options.input,
			output: options.output,
			useColor,
		});

		if (result === "delete") {
			const confirmed = await confirm(`Delete ${label}?`, false, options);
			if (!confirmed) continue;
		}

		if (result === "refresh") {
			const confirmed = await confirm(`Re-authenticate ${label}?`, false, options);
			if (!confirmed) continue;
		}

		return result ?? "cancel";
	}
}
