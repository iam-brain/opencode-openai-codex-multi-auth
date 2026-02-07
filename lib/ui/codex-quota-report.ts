import { createHash } from "node:crypto";

import type { CodexRateLimitSnapshot } from "../codex-status.js";

type AccountLike = {
	accountId?: string;
	email?: string;
	plan?: string;
	refreshToken?: string;
};

const LINE = "=".repeat(52);
const BAR_WIDTH = 20;

function getSnapshotKey(account: AccountLike): string | null {
	if (account.accountId && account.email && account.plan) {
		return `${account.accountId}|${account.email.toLowerCase()}|${account.plan}`;
	}
	if (account.refreshToken) {
		return createHash("sha256").update(account.refreshToken).digest("hex");
	}
	return null;
}

function findSnapshot(
	account: AccountLike,
	snapshots: CodexRateLimitSnapshot[],
): CodexRateLimitSnapshot | undefined {
	const key = getSnapshotKey(account);
	if (key) {
		const direct = snapshots.find((snapshot) => (snapshot as any).key === key);
		if (direct) return direct;
	}

	return snapshots.find(
		(snapshot) =>
			snapshot.accountId === account.accountId &&
			snapshot.email?.toLowerCase() === account.email?.toLowerCase() &&
			snapshot.plan === account.plan,
	);
}

function formatReset(resetAt: number, now: number): string {
	if (!resetAt || resetAt <= now) return "";
	const date = new Date(resetAt);
	const timeStr = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	if (resetAt - now <= 24 * 60 * 60 * 1000) {
		return ` (resets ${timeStr})`;
	}
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return ` (resets ${timeStr} ${date.getDate()} ${months[date.getMonth()]})`;
}

function renderBar(usedPercent: number | undefined | null): { bar: string; percent: string } {
	if (usedPercent === undefined || usedPercent === null || Number.isNaN(usedPercent)) {
		const empty = "░".repeat(BAR_WIDTH);
		return { bar: empty, percent: "???" };
	}
	const left = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
	const filled = Math.round((left / 100) * BAR_WIDTH);
	const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
	const percent = `${String(left).padStart(3, " ")}%`;
	return { bar, percent };
}

export function renderQuotaReport(
	accounts: AccountLike[],
	snapshots: CodexRateLimitSnapshot[],
	now = Date.now(),
): string[] {
	const lines: string[] = ["Checking quotas for all accounts..."];
	for (const account of accounts) {
		const email = account.email || account.accountId || "Unknown account";
		const snapshot = findSnapshot(account, snapshots);
		lines.push(LINE);
		lines.push(`  ${email}`);
		lines.push(LINE);
		lines.push("  +- Codex CLI Quota");

		const primary = renderBar(snapshot?.primary?.usedPercent);
		const primaryReset = snapshot?.primary?.resetAt
			? formatReset(snapshot.primary.resetAt, now)
			: primary.percent === "???"
				? " ???"
				: "";
		lines.push(`  |  |- GPT-5      ${primary.bar} ${primary.percent}${primaryReset}`);

		const secondary = renderBar(snapshot?.secondary?.usedPercent);
		const secondaryReset = snapshot?.secondary?.resetAt
			? formatReset(snapshot.secondary.resetAt, now)
			: secondary.percent === "???"
				? " ???"
				: "";
		lines.push(`  |  |- Weekly     ${secondary.bar} ${secondary.percent}${secondaryReset}`);

		const creditInfo = snapshot?.credits;
		const creditStr = creditInfo
			? creditInfo.unlimited
				? "unlimited"
				: `${creditInfo.balance} credits`
			: "0 credits";
		lines.push(`  |---- Credits    ${creditStr}`);
	}

	return lines;
}
