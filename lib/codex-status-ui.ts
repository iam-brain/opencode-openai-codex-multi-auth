import { type ManagedAccount } from "./accounts.js";
import { type CodexRateLimitSnapshot } from "./codex-status.js";

// Box-drawing characters
const BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	midLeft: "├",
	midRight: "┤",
	midTop: "┬",
	midBottom: "┴",
	cross: "┼",
};

// Column widths (content width, excluding borders)
function getColumnWidths() {
	const termWidth = process.stdout.columns || 100;
	
	// Minimum widths for functional columns
	const numWidth = 4;
	const statusWidth = 12;
	const planWidth = 10;
	
	// Account column takes remaining space, but at least 40 and at most 63
	const accountWidth = Math.max(40, Math.min(63, termWidth - numWidth - statusWidth - planWidth - 5));
	
	return {
		num: numWidth,
		status: statusWidth,
		account: accountWidth,
		plan: planWidth,
		total: numWidth + statusWidth + accountWidth + planWidth + 5
	};
}

function hLine(left: string, mid: string, right: string, W: ReturnType<typeof getColumnWidths>): string {
	return (
		left +
		BOX.horizontal.repeat(W.num) +
		mid +
		BOX.horizontal.repeat(W.status) +
		mid +
		BOX.horizontal.repeat(W.account) +
		mid +
		BOX.horizontal.repeat(W.plan) +
		right
	);
}

function row(num: string, status: string, account: string, plan: string, W: ReturnType<typeof getColumnWidths>): string {
	return (
		BOX.vertical +
		num.padEnd(W.num) +
		BOX.vertical +
		status.padEnd(W.status) +
		BOX.vertical +
		account.padEnd(W.account) +
		BOX.vertical +
		plan.padEnd(W.plan) +
		BOX.vertical
	);
}

function formatResetTime(resetAt: number): string {
	if (resetAt <= 0) return "";
	const resetDate = new Date(resetAt);
	const now = Date.now();
	const isMoreThan24h = resetAt - now > 24 * 60 * 60 * 1000;
	const timeStr = `${String(resetDate.getHours()).padStart(2, "0")}:${String(resetDate.getMinutes()).padStart(2, "0")}`;

	if (isMoreThan24h) {
		const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const dateStr = `${resetDate.getDate()} ${monthNames[resetDate.getMonth()]}`;
		return `(${timeStr} ${dateStr})`;
	} else {
		return `(${timeStr})`;
	}
}

export function renderObsidianDashboard(
	accounts: ManagedAccount[],
	activeIndex: number,
	snapshots: CodexRateLimitSnapshot[],
): string[] {
	const now = Date.now();
	const lines: string[] = [];
	let W = getColumnWidths();

	// Helper to find snapshot
	const findSnapshot = (acc: ManagedAccount) => {
		return snapshots.find(
			(s) =>
				s.accountId === acc.accountId &&
				s.email.toLowerCase() === acc.email?.toLowerCase() &&
				s.plan === acc.plan,
		);
	};

	const buildResetString = (resetAt: number | null | undefined) =>
		resetAt ? ` ${formatResetTime(resetAt)}` : "";
	const resetLengths: number[] = [];
	for (const account of accounts) {
		const snapshot = findSnapshot(account);
		resetLengths.push(
			buildResetString(snapshot?.primary?.resetAt).length,
			buildResetString(snapshot?.secondary?.resetAt).length,
		);
	}
	const maxResetLength = resetLengths.length ? Math.max(...resetLengths) : 0;
	const minResetLength = resetLengths.length ? Math.min(...resetLengths) : 0;
	const labelWidth = 10;
	const leftWidth = 9;
	const minBarWidth = 10;
	const fixedWidth = 1 + labelWidth + 1 + leftWidth + 1;
	const baseAvailable = Math.max(0, W.account - fixedWidth);
	const preferredBarWidth = Math.max(minBarWidth, baseAvailable - minResetLength);
	const barSpace = Math.max(0, W.account - fixedWidth - maxResetLength);
	const barWidth = Math.max(1, Math.min(preferredBarWidth, barSpace));
	const resetWidth = maxResetLength;

	const renderBar = (
		label: string,
		data: { usedPercent: number; resetAt: number } | null | undefined,
		resetStr: string,
	): string => {
		const usedPercent = data?.usedPercent ?? 0;
		const p = Math.max(0, 100 - usedPercent);
		const leftStr = `${String(p).padStart(3)}% left`;
		const filled = Math.round((p / 100) * barWidth);
		const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
		const paddedReset = resetWidth > 0 ? resetStr.padEnd(resetWidth) : "";
		return ` ${label.padEnd(labelWidth)}${bar} ${leftStr}${paddedReset} `;
	};

	// Top border
	lines.push(hLine(BOX.topLeft, BOX.midTop, BOX.topRight, W));

	// Header row
	lines.push(row(" #", " STATUS", " ACCOUNT", " PLAN", W));

	// Header separator
	lines.push(hLine(BOX.midLeft, BOX.cross, BOX.midRight, W));

	accounts.forEach((acc, i) => {
		const isActive = i === activeIndex;
		const isEnabled = acc.enabled !== false;
		const isAuthFailed =
			acc.coolingDownUntil !== undefined &&
			acc.coolingDownUntil > now &&
			acc.cooldownReason === "auth-failure";

		// Status with indicator
		let statusLabel: string;
		let statusIndicator: string;
		if (!isEnabled) {
			statusIndicator = "○";
			statusLabel = "DISABLED";
		} else if (isAuthFailed) {
			statusIndicator = "✕";
			statusLabel = "AUTH ERR";
		} else if (isActive) {
			statusIndicator = "●";
			statusLabel = "ACTIVE";
		} else {
			statusIndicator = "○";
			statusLabel = "READY";
		}

		const statusStr = ` ${statusIndicator} ${statusLabel}`;
		const emailStr = ` ${acc.email || "unknown"}`;
		const planStr = ` ${acc.plan || "Free"}`;

		// Main row with email
		lines.push(row(` ${i + 1}`, statusStr, emailStr, planStr, W));

		// Snapshot data rows
		const snapshot = findSnapshot(acc);
		const primaryResetStr = buildResetString(snapshot?.primary?.resetAt);
		const secondaryResetStr = buildResetString(snapshot?.secondary?.resetAt);

		// Progress bar rows
		lines.push(row("", "", renderBar("5h Limit", snapshot?.primary, primaryResetStr), "", W));
		lines.push(row("", "", renderBar("Weekly", snapshot?.secondary, secondaryResetStr), "", W));

		// Credits row
		const creditInfo = snapshot?.credits;
		const creditStr = creditInfo
			? creditInfo.unlimited
				? "unlimited"
				: `${creditInfo.balance} credits`
			: "0 credits";
		lines.push(row("", "", ` ${"Credits".padEnd(10)} ${creditStr}`, "", W));

		// Row separator or bottom border
		if (i < accounts.length - 1) {
			lines.push(hLine(BOX.midLeft, BOX.cross, BOX.midRight, W));
		}
	});

	// Bottom border
	lines.push(hLine(BOX.bottomLeft, BOX.midBottom, BOX.bottomRight, W));

	return lines;
}
