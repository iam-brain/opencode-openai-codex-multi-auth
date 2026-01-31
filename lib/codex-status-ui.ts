import { type ManagedAccount } from "./accounts.js";
import { type CodexRateLimitSnapshot } from "./codex-status.js";

const clr = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	magenta: "\x1b[35m",
	red: "\x1b[31m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	bgBlue: "\x1b[44m",
	bgGreen: "\x1b[42m",
	bgRed: "\x1b[41m",
};

/**
 * Strips ANSI escape codes to calculate visible string length
 */
function getVisibleLength(str: string): number {
	// eslint-disable-next-line no-control-regex
	return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Pads a string with ANSI codes to a specific visible length
 */
function padVisible(str: string, length: number, char = " "): string {
	const visibleLen = getVisibleLength(str);
	const padding = char.repeat(Math.max(0, length - visibleLen));
	return str + padding;
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
		return `(resets ${timeStr} on ${dateStr})`;
	} else {
		return `(resets ${timeStr})`;
	}
}

export function renderObsidianDashboard(
	accounts: ManagedAccount[],
	activeIndex: number,
	snapshots: CodexRateLimitSnapshot[],
): string[] {
	const now = Date.now();
	const lines: string[] = [];

	// Column Widths (Restored to perfect alignment values)
	const W_NUM = 4;
	const W_STATUS = 10;
	const W_EMAIL = 42;
	const W_PLAN = 11;
	// No W_QUOTA needed for right wall anymore, just extend PLAN

	// Helper to find snapshot
	const findSnapshot = (acc: ManagedAccount) => {
		return snapshots.find(
			(s) =>
				s.accountId === acc.accountId &&
				s.email.toLowerCase() === acc.email?.toLowerCase() &&
				s.plan === acc.plan,
		);
	};

	// Header
	// Shift STATUS header +2 spaces relative to data column (which has 1 space padding)
	// Original: " STATUS" (1 space)
	// New:      "   STATUS" (3 spaces)
	const hRow =
		padVisible(`  #`, W_NUM) +
		padVisible(`   STATUS`, W_STATUS) + 
		` ` + // +1 Shift for ACCOUNT column
		padVisible(`ACCOUNT`, W_EMAIL) +
		` ` + // +1 Shift for PLAN column
		`PLAN`;
	lines.push(`${clr.bold}${hRow}${clr.reset}`);

	const divider =
		padVisible(`  ${"-".repeat(W_NUM - 2)}`, W_NUM) +
		padVisible("   " + "-".repeat(W_STATUS - 4), W_STATUS) + // Match header shift (3 spaces indent)
		` ` + // +1 Shift for divider
		padVisible("-".repeat(W_EMAIL - 1), W_EMAIL) +
		` ` + // +1 Shift for divider
		"-".repeat(50); // Extended underline for PLAN + Usage
	lines.push(`${clr.gray}${divider}${clr.reset}`);

	accounts.forEach((acc, i) => {
		const isActive = i === activeIndex;
		const isEnabled = acc.enabled !== false;
		const isAuthFailed =
			acc.coolingDownUntil !== undefined &&
			acc.coolingDownUntil > now &&
			acc.cooldownReason === "auth-failure";

		let statusLabel = "";
		let statusStyle = "";

		if (!isEnabled) {
			statusLabel = " DISABLED";
			statusStyle = `${clr.bgRed}${clr.white}`;
		} else if (isAuthFailed) {
			statusLabel = " AUTH ERR";
			statusStyle = `${clr.bgRed}${clr.white}`;
		} else if (isActive) {
			statusLabel = "  ACTIVE ";
			statusStyle = `${clr.bgBlue}${clr.white}`;
		} else {
			statusLabel = " ENABLED ";
			statusStyle = `${clr.bgGreen}${clr.white}`;
		}

		const num = `  ${i + 1}`;
		const status = `${statusStyle}${statusLabel}${clr.reset}`;
		const email = `${clr.bold}${padVisible(acc.email || "unknown", W_EMAIL - 1)}${clr.reset}`;
		const plan = `${clr.magenta}${padVisible(acc.plan || "Free", W_PLAN - 1)}${clr.reset}`;

		// Main Row
		// Keep data column aligned to original grid (1 space padding)
		// Add +1 space before email and plan to match headers
		// Add +1 space before plan
		const mainRowContent =
			padVisible(num, W_NUM) + " " + padVisible(status, W_STATUS - 1) + " " + email + "  " + plan;
		lines.push(mainRowContent);

		// Snapshot Data
		const snapshot = findSnapshot(acc);
		const indent = " ".repeat(W_NUM + W_STATUS + 1); // Indent +1 to match shift

		const renderBar = (label: string, data: { usedPercent: number; resetAt: number } | null | undefined) => {
			const barWidth = 20;
			const usedPercent = data?.usedPercent ?? 0;
			const p = Math.max(0, 100 - usedPercent);
			const filled = Math.round((p / 100) * barWidth);
			const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
			const color = p > 50 ? clr.blue : p > 20 ? clr.yellow : clr.red;
			const leftStr = `${String(p).padStart(3)}% left`;
			const resetStr = data?.resetAt ? formatResetTime(data.resetAt) : "";

			return `${clr.gray}${label.padEnd(9)}${clr.reset}[${color}${bar}${clr.reset}] ${clr.gray}${leftStr}${clr.reset} ${clr.dim}${resetStr}${clr.reset}`;
		};

		// Bar Rows
		lines.push(indent + renderBar("5h Limit", snapshot?.primary));
		lines.push(indent + renderBar("Weekly", snapshot?.secondary));

		// Credits Row
		if (snapshot?.credits) {
			const { unlimited, balance } = snapshot.credits;
			const creditStr = unlimited ? "unlimited" : `${balance} credits`;
			const creditRow = `${indent}${clr.gray}${"Credits".padEnd(9)}${clr.reset}${creditStr}`;
			lines.push(creditRow);
		}

		if (i < accounts.length - 1) {
			lines.push("");
		}
	});

	return lines;
}
