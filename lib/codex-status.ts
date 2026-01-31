import { createHash } from "node:crypto";
import { type AccountRecordV3 } from "./types.js";

export interface CodexRateLimitSnapshot {
	accountId: string;
	email: string;
	plan: string;
	updatedAt: number;
	primary: {
		usedPercent: number;
		windowMinutes: number;
		resetAt: number;
	} | null;
	secondary: {
		usedPercent: number;
		windowMinutes: number;
		resetAt: number;
	} | null;
	credits: {
		hasCredits: boolean;
		unlimited: boolean;
		balance: number;
	} | null;
}

const STALENESS_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class CodexStatusManager {
	private readonly snapshots = new Map<string, CodexRateLimitSnapshot>();

	private getSnapshotKey(account: Partial<AccountRecordV3>): string {
		if (account.accountId && account.email && account.plan) {
			return `${account.accountId}|${account.email}|${account.plan}`;
		}
		// Fallback to a hash of the refresh token if identity is missing (security hardening)
		if (account.refreshToken) {
			return createHash("sha256").update(account.refreshToken).digest("hex");
		}
		return "unknown";
	}

	updateFromHeaders(account: AccountRecordV3, headers: Record<string, string | string[] | undefined>): void {
		const getHeader = (name: string): string | undefined => {
			const val = headers[name] || headers[name.toLowerCase()];
			return Array.isArray(val) ? val[0] : val;
		};

		const parseNum = (val: string | undefined): number | null => {
			if (val === undefined || val === "") return null;
			const n = Number(val);
			return isNaN(n) ? null : n;
		};

		const parseBool = (val: string | undefined): boolean | null => {
			if (val === undefined || val === "") return null;
			return val === "true" || val === "1";
		};

		const primaryUsed = parseNum(getHeader("x-codex-primary-used-percent"));
		const primaryWindow = parseNum(getHeader("x-codex-primary-window-minutes"));
		const primaryReset = parseNum(getHeader("x-codex-primary-reset-at"));

		const secondaryUsed = parseNum(getHeader("x-codex-secondary-used-percent"));
		const secondaryWindow = parseNum(getHeader("x-codex-secondary-window-minutes"));
		const secondaryReset = parseNum(getHeader("x-codex-secondary-reset-at"));

		const hasCredits = parseBool(getHeader("x-codex-credits-has-credits"));
		const unlimited = parseBool(getHeader("x-codex-credits-unlimited"));
		const balance = parseNum(getHeader("x-codex-credits-balance"));

		const key = this.getSnapshotKey(account);
		const existing = this.snapshots.get(key);

		const snapshot: CodexRateLimitSnapshot = {
			accountId: account.accountId || "",
			email: account.email || "",
			plan: account.plan || "",
			updatedAt: Date.now(),
			primary:
				primaryUsed !== null || primaryWindow !== null || primaryReset !== null
					? {
							usedPercent: Math.max(0, Math.min(100, primaryUsed ?? (existing?.primary?.usedPercent || 0))),
							windowMinutes: Math.max(0, primaryWindow ?? (existing?.primary?.windowMinutes || 0)),
							resetAt: primaryReset ?? (existing?.primary?.resetAt || 0),
						}
					: (existing?.primary || null),
			secondary:
				secondaryUsed !== null || secondaryWindow !== null || secondaryReset !== null
					? {
							usedPercent: Math.max(0, Math.min(100, secondaryUsed ?? (existing?.secondary?.usedPercent || 0))),
							windowMinutes: Math.max(0, secondaryWindow ?? (existing?.secondary?.windowMinutes || 0)),
							resetAt: secondaryReset ?? (existing?.secondary?.resetAt || 0),
						}
					: (existing?.secondary || null),
			credits:
				hasCredits !== null || unlimited !== null || balance !== null
					? {
							hasCredits: hasCredits ?? (existing?.credits?.hasCredits || false),
							unlimited: unlimited ?? (existing?.credits?.unlimited || false),
							balance: balance ?? (existing?.credits?.balance || 0),
						}
					: (existing?.credits || null),
		};

		this.snapshots.set(key, snapshot);
	}

	getSnapshot(account: AccountRecordV3): (CodexRateLimitSnapshot & { isStale: boolean }) | null {
		const key = this.getSnapshotKey(account);
		const snapshot = this.snapshots.get(key);
		if (!snapshot) return null;

		return {
			...snapshot,
			isStale: Date.now() - snapshot.updatedAt > STALENESS_TTL_MS,
		};
	}

	getAllSnapshots(): CodexRateLimitSnapshot[] {
		return Array.from(this.snapshots.values());
	}

	renderStatus(account: AccountRecordV3): string[] {
		const snapshot = this.getSnapshot(account);
		if (!snapshot) {
			return ["  No Codex status data yet"];
		}

		const lines: string[] = [];
		const staleLabel = snapshot.isStale ? " (stale)" : "";

		const formatWindow = (mins: number) => {
			if (mins <= 0) return null;
			if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`;
			if (mins % 60 === 0) return `${mins / 60}h`;
			return `${mins}m`;
		};

		const renderBar = (label: string, data: { usedPercent: number; resetAt: number } | null) => {
			if (!data) return null;
			const width = 20;
			const filled = Math.round((data.usedPercent / 100) * width);
			const bar = "█".repeat(filled) + "░".repeat(width - filled);
			const resetDate = new Date(data.resetAt);
			const resetStr =
				data.resetAt > 0
					? ` (reset ${resetDate.getHours()}:${String(resetDate.getMinutes()).padStart(2, "0")})`
					: "";
			return `  ${label.padEnd(8)} [${bar}] ${data.usedPercent.toFixed(1)}%${resetStr}${staleLabel}`;
		};

		const primaryLabel = formatWindow(snapshot.primary?.windowMinutes || 0) || "Primary";
		const primaryLine = renderBar(primaryLabel, snapshot.primary);
		if (primaryLine) lines.push(primaryLine);

		const secondaryLabel = formatWindow(snapshot.secondary?.windowMinutes || 0) || "Weekly";
		const secondaryLine = renderBar(secondaryLabel, snapshot.secondary);
		if (secondaryLine) lines.push(secondaryLine);

		if (snapshot.credits) {
			const { unlimited, balance } = snapshot.credits;
			const creditStr = unlimited ? "unlimited" : `${balance.toFixed(2)} credits`;
			lines.push(`  Credits  ${creditStr}${staleLabel}`);
		}

		return lines;
	}
}

export const codexStatus = new CodexStatusManager();
