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

	// Column Widths & Grid
	const W_NUM = 4;
	const W_STATUS = 12;
	const W_EMAIL = 42;
	const GAP = "  "; // Reduced to 2 spaces to keep it compact

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
	const hRow =
		padVisible(`  #`, W_NUM) +
		GAP +
		padVisible(`  STATUS`, W_STATUS) + 
		GAP +
		padVisible(`ACCOUNT`, W_EMAIL) +
		GAP +
		`PLAN`;
	lines.push(`${clr.bold}${hRow}${clr.reset}`);

	const divider =
		padVisible(`  --`, W_NUM) +
		GAP +
		padVisible(`  ` + "-".repeat(W_STATUS - 2), W_STATUS) + 
		GAP +
		padVisible("-".repeat(W_EMAIL), W_EMAIL) +
		GAP +
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
		const email = `${clr.bold}${acc.email || "unknown"}${clr.reset}`;
		const plan = `${clr.magenta}${acc.plan || "Free"}${clr.reset}`;

		// Main Row
		const mainRowContent =
			padVisible(num, W_NUM) + 
			GAP + 
			padVisible(status, W_STATUS) + 
			GAP +
			padVisible(email, W_EMAIL) + 
			GAP +
			plan;
		lines.push(mainRowContent);

		// Snapshot Data
		const snapshot = findSnapshot(acc);
		// Indent to match ACCOUNT column (W_NUM + GAP.length + W_STATUS + GAP.length) = 20
		const indent = " ".repeat(W_NUM + GAP.length + W_STATUS + GAP.length); 

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
		if (snapshot) {
			const creditInfo = snapshot.credits;
			const creditStr = creditInfo ? (creditInfo.unlimited ? "unlimited" : `${creditInfo.balance} credits`) : "0 credits";
			const creditRow = `${indent}${clr.gray}${"Credits".padEnd(9)}${clr.reset}${creditStr}`;
			lines.push(creditRow);
		}

		if (i < accounts.length - 1) {
			lines.push("");
		}
	});

	return lines;
}
