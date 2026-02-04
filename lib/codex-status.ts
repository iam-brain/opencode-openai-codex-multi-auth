import { promises as fs, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { type AccountRecordV3, type CodexWhamUsageResponse } from "./types.js";
import { getCachePath } from "./storage.js";
import { normalizePlanTypeOrDefault } from "./plan-utils.js";
import { getAuthDebugEnabled } from "./config.js";

export interface CodexRateLimitSnapshot {
	key?: string;
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
		balance: string;
	} | null;
}

const STALENESS_TTL_MS = 15 * 60 * 1000;
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOTS_FILE = "codex-snapshots.json";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_URL = "https://api.openai.com/api/codex/usage";

const LOCK_OPTIONS = {
	stale: 10_000,
	retries: {
		retries: 5,
		minTimeout: 100,
		maxTimeout: 1000,
		factor: 2,
	},
	realpath: false,
};

export class CodexStatusManager {
	private snapshots = new Map<string, CodexRateLimitSnapshot>();
	private initPromise: Promise<void> | null = null;

	private async ensureInitialized(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.loadFromDisk();
		return this.initPromise;
	}

	private getSnapshotKey(account: Partial<AccountRecordV3>): string {
		let key: string;
		if (account.accountId && account.email && account.plan) {
			const plan = normalizePlanTypeOrDefault(account.plan);
			key = `${account.accountId}|${account.email.toLowerCase()}|${plan}`;
		} else if (account.refreshToken) {
			// Hash the refresh token to use as a stable, secure key for legacy accounts
			key = createHash("sha256").update(account.refreshToken).digest("hex");
		} else {
			key = "unknown";
		}

		if (getAuthDebugEnabled()) {
			console.log(`[CodexStatus] Generated key: ${key}`);
		}
		return key;
	}

	async updateFromHeaders(
		account: AccountRecordV3,
		headers: Record<string, string | string[] | undefined>,
	): Promise<void> {
		if (getAuthDebugEnabled()) {
			console.log(`[CodexStatus] Updating from headers for ${account.email}:`, JSON.stringify(headers));
		}
		await this.ensureInitialized();
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
		let primaryReset = parseNum(getHeader("x-codex-primary-reset-at"));
		// Handle unix seconds (Codex API style)
		if (primaryReset !== null && primaryReset < 2000000000) {
			primaryReset *= 1000;
		}

		const secondaryUsed = parseNum(getHeader("x-codex-secondary-used-percent"));
		const secondaryWindow = parseNum(getHeader("x-codex-secondary-window-minutes"));
		let secondaryReset = parseNum(getHeader("x-codex-secondary-reset-at"));
		if (secondaryReset !== null && secondaryReset < 2000000000) {
			secondaryReset *= 1000;
		}

		const hasCredits = parseBool(getHeader("x-codex-credits-has-credits"));
		const unlimited = parseBool(getHeader("x-codex-credits-unlimited"));
		const balance = getHeader("x-codex-credits-balance");

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
				hasCredits !== null || unlimited !== null || balance !== undefined
					? {
							hasCredits: hasCredits ?? (existing?.credits?.hasCredits || false),
							unlimited: unlimited ?? (existing?.credits?.unlimited || false),
							balance: balance ?? (existing?.credits?.balance || "0"),
						}
					: (existing?.credits || null),
		};

		this.snapshots.set(key, snapshot);
		await this.saveToDisk();
	}

	async getSnapshot(
		account: AccountRecordV3,
	): Promise<(CodexRateLimitSnapshot & { isStale: boolean }) | null> {
		await this.ensureInitialized();
		const key = this.getSnapshotKey(account);
		const snapshot = this.snapshots.get(key);
		if (!snapshot) return null;

		return {
			...snapshot,
			isStale: Date.now() - snapshot.updatedAt > STALENESS_TTL_MS,
		};
	}

	async getAllSnapshots(): Promise<CodexRateLimitSnapshot[]> {
		await this.ensureInitialized();
		return Array.from(this.snapshots.entries()).map(([key, snapshot]) => ({
			...snapshot,
			key,
		}));
	}

	async renderStatus(account: AccountRecordV3): Promise<string[]> {
		const snapshot = await this.getSnapshot(account);
		const lines: string[] = [];
		const staleLabel = snapshot?.isStale ? " (stale)" : "";

		const formatWindow = (mins: number) => {
			if (mins <= 0) return null;
			if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`;
			if (mins % 60 === 0) return `${mins / 60}h`;
			return `${mins}m`;
		};

		const renderBar = (label: string, data: { usedPercent: number; resetAt: number } | null) => {
			const width = 20;
			const usedPercent = data?.usedPercent ?? 100;
			const leftPercent = Math.max(0, 100 - usedPercent);
			const filled = Math.round((leftPercent / 100) * width);
			const bar = "█".repeat(filled) + "░".repeat(width - filled);

			let resetStr = "";
			if (data && data.resetAt > 0) {
				const resetDate = new Date(data.resetAt);
				const now = Date.now();
				const isMoreThan24h = data.resetAt - now > 24 * 60 * 60 * 1000;
				const timeStr = `${String(resetDate.getHours()).padStart(2, "0")}:${String(resetDate.getMinutes()).padStart(2, "0")}`;

				if (isMoreThan24h) {
					const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
					const dateStr = `${resetDate.getDate()} ${monthNames[resetDate.getMonth()]}`;
					resetStr = ` (resets ${timeStr} on ${dateStr})`;
				} else {
					resetStr = ` (resets ${timeStr})`;
				}
			} else if (!data) {
				return `  ${(label + ":").padEnd(16)} [${"░".repeat(width)}] unknown`.padEnd(65);
			}

			const statusStr = `${leftPercent.toFixed(0)}% left`.padEnd(9);
			return `  ${(label + ":").padEnd(16)} [${bar}] ${statusStr}${resetStr}${staleLabel}`.padEnd(65);
		};

		if (!snapshot) {
			lines.push(renderBar("5 hour limit", null)!);
			lines.push(renderBar("Weekly limit", null)!);
			return lines;
		}

		const primaryLabel = formatWindow(snapshot.primary?.windowMinutes || 0);
		const primaryHeader = primaryLabel === "5h" ? "5 hour limit" : `${primaryLabel || "5 hour"} limit`;
		lines.push(renderBar(primaryHeader, snapshot.primary)!);

		const secondaryLabel = formatWindow(snapshot.secondary?.windowMinutes || 0);
		const secondaryHeader = secondaryLabel === "7d" || secondaryLabel === "weekly" ? "Weekly limit" : `${secondaryLabel || "Weekly"} limit`;
		lines.push(renderBar(secondaryHeader, snapshot.secondary)!);

		if (snapshot.credits) {
			const { unlimited, balance } = snapshot.credits;
			const creditStr = unlimited ? "unlimited" : `${balance} credits`;
			lines.push(`  Credits  ${creditStr}${staleLabel}`.padEnd(52));
		}


		if (getAuthDebugEnabled()) {
			const updateTime = new Date(snapshot.updatedAt);
			lines.push(`  Updated  ${updateTime.getHours()}:${String(updateTime.getMinutes()).padStart(2, "0")}:${String(updateTime.getSeconds()).padStart(2, "0")}`);
		}

		return lines;
	}

	private async loadFromDisk(): Promise<void> {
		const path = getCachePath(SNAPSHOTS_FILE);
		if (getAuthDebugEnabled()) {
			console.log(`[CodexStatus] Loading snapshots from ${path}`);
		}
		if (!existsSync(path)) return;
		try {
			const data = JSON.parse(await fs.readFile(path, "utf-8"));
			if (Array.isArray(data)) {
				this.snapshots = new Map(data);
			}
		} catch {
			// ignore load errors
		}
	}

	private async saveToDisk(): Promise<void> {
		const path = getCachePath(SNAPSHOTS_FILE);
		const dir = dirname(path);

		try {
			if (!existsSync(dir)) {
				await fs.mkdir(dir, { recursive: true });
			}

			if (!existsSync(path)) {
				await fs.writeFile(path, "[]", { encoding: "utf-8", mode: 0o600 });
			}

			let release: (() => Promise<void>) | null = null;
			try {
				release = await lockfile.lock(path, LOCK_OPTIONS);
				// Re-load snapshots from disk before merging and saving to avoid lost updates
				try {
					const diskData = JSON.parse(await fs.readFile(path, "utf-8"));
					if (Array.isArray(diskData)) {
						const diskMap = new Map<string, CodexRateLimitSnapshot>(diskData);
						const now = Date.now();

						// Merge memory into disk data (newer updatedAt wins)
						for (const [key, memoryValue] of this.snapshots) {
							const diskValue = diskMap.get(key);
							if (!diskValue || memoryValue.updatedAt > diskValue.updatedAt) {
								diskMap.set(key, memoryValue);
							}
						}

						// Prune extremely stale data (retention cleanup)
						for (const [key, value] of diskMap) {
							if (now - value.updatedAt > SNAPSHOT_RETENTION_MS) {
								diskMap.delete(key);
							}
						}

						this.snapshots = diskMap;
					}
				} catch {
					// fallback to just saving what we have
				}

				const data = JSON.stringify(Array.from(this.snapshots.entries()), null, 2);
				const tmpPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
				await fs.writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
				await fs.rename(tmpPath, path);
			} finally {
				if (release) {
					await release().catch(() => undefined);
				}
			}
		} catch (error) {
			if (getAuthDebugEnabled()) {
				console.error("[CodexStatus] Failed to save snapshots:", error);
			}
		}
	}
	/**
	 * Update from an explicit RateLimitSnapshot object (Codex API style)
	 */
	async updateFromSnapshot(account: AccountRecordV3, snapshot: any): Promise<void> {
		if (!snapshot) return;
		await this.ensureInitialized();

		const key = this.getSnapshotKey(account);
		const existing = this.snapshots.get(key);

		const toMs = (s: number | null | undefined) => {
			if (s === null || s === undefined) return null;
			return s < 2000000000 ? s * 1000 : s;
		};

		const updated: CodexRateLimitSnapshot = {
			accountId: account.accountId || "",
			email: account.email || "",
			plan: account.plan || "",
			updatedAt: Date.now(),
			primary: snapshot.primary
				? {
						usedPercent: snapshot.primary.used_percent,
						windowMinutes: snapshot.primary.window_minutes || (existing?.primary?.windowMinutes || 0),
						resetAt: toMs(snapshot.primary.resets_at) || (existing?.primary?.resetAt || 0),
					}
				: (existing?.primary || null),
			secondary: snapshot.secondary
				? {
						usedPercent: snapshot.secondary.used_percent,
						windowMinutes: snapshot.secondary.window_minutes || (existing?.secondary?.windowMinutes || 0),
						resetAt: toMs(snapshot.secondary.resets_at) || (existing?.secondary?.resetAt || 0),
					}
				: (existing?.secondary || null),
			credits: snapshot.credits
				? {
						hasCredits: snapshot.credits.has_credits,
						unlimited: snapshot.credits.unlimited,
						balance: snapshot.credits.balance || (existing?.credits?.balance || "0"),
					}
				: (existing?.credits || null),
		};

		this.snapshots.set(key, updated);
		await this.saveToDisk();
	}

	async fetchFromBackend(account: AccountRecordV3, accessToken: string): Promise<void> {
		const isChatGPT = accessToken.split(".").length === 3;
		const url = isChatGPT ? WHAM_USAGE_URL : CODEX_USAGE_URL;

		try {
			const res = await fetch(url, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"OpenAI-Account-Id": account.accountId || "",
					Accept: "application/json",
					"User-Agent": "codex_cli_rs",
					Origin: "https://chatgpt.com",
				},
			});

			if (res.ok) {
				const json = (await res.json()) as CodexWhamUsageResponse;

				// Standardize the /wham/usage structure into our internal snapshot
				const data: any = {};
				if (json.rate_limit) {
					if (json.rate_limit.primary_window) {
						data.primary = {
							used_percent: json.rate_limit.primary_window.used_percent,
							window_minutes: json.rate_limit.primary_window.limit_window_seconds / 60,
							resets_at: json.rate_limit.primary_window.reset_at,
						};
					}
					if (json.rate_limit.secondary_window) {
						data.secondary = {
							used_percent: json.rate_limit.secondary_window.used_percent,
							window_minutes: json.rate_limit.secondary_window.limit_window_seconds / 60,
							resets_at: json.rate_limit.secondary_window.reset_at,
						};
					}
				}

				if (json.credits) {
					data.credits = {
						has_credits: json.credits.has_credits,
						unlimited: json.credits.unlimited,
						balance: json.credits.balance,
					};
				}

				await this.updateFromSnapshot(account, data);
			} else if (getAuthDebugEnabled()) {
				console.log(`[CodexStatus] Backend returned ${res.status} for ${account.email}, using cached snapshot`);
			}
		} catch (err) {
			if (getAuthDebugEnabled()) {
				console.error(`[CodexStatus] Fetch failed for ${account.email}:`, err);
			}
		}
	}
}

export const codexStatus = new CodexStatusManager();
