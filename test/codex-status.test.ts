import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CodexStatusManager } from "../lib/codex-status.js";
import { getCachePath } from "../lib/storage.js";
import type { AccountRecordV3 } from "../lib/types.js";
import { renderObsidianDashboard } from "../lib/codex-status-ui.js";
import type { ManagedAccount } from "../lib/accounts.js";

const ACCOUNTS_FIXTURE_PATH = join(__dirname, "fixtures", "openai-codex-accounts.json");
const SNAPSHOT_FIXTURE_PATH = join(__dirname, "fixtures", "codex-status-snapshots.json");
const HEADERS_FIXTURE_PATH = join(__dirname, "fixtures", "codex-headers.json");

describe("CodexStatusManager", () => {
	let accountsFixture: { accounts: AccountRecordV3[] };
	let testAccount: AccountRecordV3;

	beforeEach(() => {
		accountsFixture = JSON.parse(readFileSync(ACCOUNTS_FIXTURE_PATH, "utf-8"));
		testAccount = accountsFixture.accounts[0]!;

		// Clear potential cache files before each test to ensure isolation
		const cachePath = getCachePath("codex-snapshots.json");
		if (existsSync(cachePath)) {
			try {
				unlinkSync(cachePath);
			} catch {
				// ignore
			}
		}
	});

	it("parses valid headers and stores snapshot", async () => {
		const manager = new CodexStatusManager();
		await manager.updateFromHeaders(testAccount, {
			"x-codex-primary-used-percent": "45.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "123456789",
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-unlimited": "false",
			"x-codex-credits-balance": "15.5",
		});

		const snapshot = await manager.getSnapshot(testAccount);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.primary?.usedPercent).toBe(45.5);
		expect(snapshot?.primary?.windowMinutes).toBe(300);
		expect(snapshot?.credits?.balance).toBe("15.5");
		expect(snapshot?.credits?.unlimited).toBe(false);
	});

	it("loads data from fixture and matches snapshots", async () => {
		const fixtureData = JSON.parse(readFileSync(SNAPSHOT_FIXTURE_PATH, "utf-8"));
		const cachePath = getCachePath("codex-snapshots.json");
		
		// Seed the cache with fixture data
		writeFileSync(cachePath, JSON.stringify(fixtureData));

		const manager = new CodexStatusManager();
		
		// Account 1 (Plus) - from fixtures/openai-codex-accounts.json
		const account1 = accountsFixture.accounts[0]!;
		const snap1 = await manager.getSnapshot(account1);
		expect(snap1?.primary?.usedPercent).toBe(45.5);
		expect(snap1?.secondary?.windowMinutes).toBe(10080);

		// Account 2 (Team)
		const account2 = accountsFixture.accounts[1]!;
		const snap2 = await manager.getSnapshot(account2);
		expect(snap2?.primary?.usedPercent).toBe(0);
		expect(snap2?.credits?.balance).toBe(15.5);

		// Account 3 (Team, shared ID)
		const account3 = accountsFixture.accounts[2]!;
		const snap3 = await manager.getSnapshot(account3);
		expect(snap3?.primary?.usedPercent).toBe(100);
		expect(snap3?.credits?.unlimited).toBe(true);
	});

	it("updates snapshots correctly from raw header fixture", async () => {
		const fixture = JSON.parse(readFileSync(HEADERS_FIXTURE_PATH, "utf-8"));
		const manager = new CodexStatusManager();

		for (const item of fixture.headers) {
			const matchingAccount = accountsFixture.accounts.find(a => 
				a.accountId === item.account.accountId && 
				a.email === item.account.email && 
				a.plan === item.account.plan
			);
			
			const account = matchingAccount || {
				refreshToken: "mock-token",
				...item.account,
				addedAt: 0,
				lastUsed: 0,
			};
			
			await manager.updateFromHeaders(account, item.raw);
			
			const snapshot = await manager.getSnapshot(account);
			expect(snapshot).not.toBeNull();
			expect(snapshot?.primary?.usedPercent).toBe(Number(item.raw["x-codex-primary-used-percent"]));
		}
	});

	it("clumps usedPercent to 0-100", async () => {
		const manager = new CodexStatusManager();
		await manager.updateFromHeaders(testAccount, {
			"x-codex-primary-used-percent": "150",
			"x-codex-secondary-used-percent": "-50",
		});

		const snapshot = await manager.getSnapshot(testAccount);
		expect(snapshot?.primary?.usedPercent).toBe(100);
		expect(snapshot?.secondary?.usedPercent).toBe(0);
	});

	it("tracks staleness", async () => {
		vi.useFakeTimers();
		try {
			const manager = new CodexStatusManager();
			await manager.updateFromHeaders(testAccount, {
				"x-codex-primary-used-percent": "10",
			});

			expect((await manager.getSnapshot(testAccount))?.isStale).toBe(false);

			// Advance 16 minutes (TTL is 15)
			vi.advanceTimersByTime(16 * 60 * 1000);
			expect((await manager.getSnapshot(testAccount))?.isStale).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("merges partial headers with existing data", async () => {
		const manager = new CodexStatusManager();
		await manager.updateFromHeaders(testAccount, {
			"x-codex-primary-used-percent": "10",
			"x-codex-primary-window-minutes": "300",
		});

		await manager.updateFromHeaders(testAccount, {
			"x-codex-primary-used-percent": "20",
		});

		const snapshot = await manager.getSnapshot(testAccount);
		expect(snapshot?.primary?.usedPercent).toBe(20);
		expect(snapshot?.primary?.windowMinutes).toBe(300); // Preserved from previous update
	});

	it("renders status bars correctly", async () => {
		const manager = new CodexStatusManager();
		await manager.updateFromHeaders(testAccount, {
			"x-codex-primary-used-percent": "50",
			"x-codex-primary-window-minutes": "0", // Force 5 hour label fallback
			"x-codex-secondary-used-percent": "25",
			"x-codex-credits-unlimited": "true",
		});

		const lines = await manager.renderStatus(testAccount);
		// Check for key components (100 - 50 = 50% left, 100 - 25 = 75% left)
		expect(lines.some(l => l.includes("5 hour limit:") && l.includes("50% left"))).toBe(true);
		expect(lines.some(l => l.includes("Weekly limit:") && l.includes("75% left"))).toBe(true);
		expect(lines.some(l => l.includes("Credits") && l.includes("unlimited"))).toBe(true);
	});

	it("aligns limit bars and keeps consistent widths", () => {
		const originalColumns = process.stdout.columns;
		Object.defineProperty(process.stdout, "columns", { value: 70, configurable: true });
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-02-03T00:00:00Z"));
			const baseAccount: ManagedAccount = {
				index: 0,
				accountId: "1f2e3d4c-5b6a-7980-91a2-b3c4d5e6f708",
				email: "user.one@example.com",
				plan: "Plus",
				enabled: true,
				refreshToken: "rt_test",
				originalRefreshToken: "rt_test",
				addedAt: 0,
				lastUsed: 0,
				rateLimitResetTimes: {},
			};
			const now = Date.now();
			const snapshots = [
				{
					accountId: baseAccount.accountId!,
					email: baseAccount.email!,
					plan: baseAccount.plan!,
					updatedAt: now,
					primary: {
						usedPercent: 45,
						windowMinutes: 300,
						resetAt: now + 48 * 60 * 60 * 1000,
					},
					secondary: {
						usedPercent: 10,
						windowMinutes: 10080,
						resetAt: now + 60 * 60 * 1000,
					},
					credits: null,
				},
			];

			const baseLines = renderObsidianDashboard([baseAccount], 0, []);
			const lines = renderObsidianDashboard([baseAccount], 0, snapshots);
			const topLength = lines[0]?.length ?? 0;
			const baseLength = baseLines[0]?.length ?? 0;
			const limitLines = lines.filter((line) => line.includes("5h Limit") || line.includes("Weekly"));
			const bars = limitLines.map((line) => {
				const match = line.match(/(?<bar>[█░]+)\s+\d{1,3}% left/);
				if (!match?.groups?.bar) return null;
				const bar = match.groups.bar;
				const barStart = line.indexOf(bar);
				return {
					bar,
					barStart,
					barEnd: barStart + bar.length,
				};
			});
			const trailingChars = limitLines.map((line) => line.charAt(line.length - 2));

			expect(limitLines.length).toBe(2);
			expect(topLength).toBe(baseLength);
			expect(lines.every((line) => line.length === topLength)).toBe(true);
			expect(limitLines.every((line) => line.endsWith("│"))).toBe(true);
			expect(trailingChars.every((char) => char === " ")).toBe(true);
			expect(
				limitLines.some((line) =>
					/\(\d{2}:\d{2} \d{1,2} [A-Z][a-z]{2}\)/.test(line),
				),
			).toBe(true);
			expect(bars.every(Boolean)).toBe(true);
			expect(bars[0]?.bar.length).toBeGreaterThan(0);
			expect(bars[0]?.bar.length).toBe(bars[1]?.bar.length);
			expect(bars[0]?.barStart).toBe(bars[1]?.barStart);
			expect(bars[0]?.barEnd).toBe(bars[1]?.barEnd);
		} finally {
			vi.useRealTimers();
			Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
		}
	});

	it("persists snapshots to disk and reloads them", async () => {
		const manager1 = new CodexStatusManager();
		await manager1.updateFromHeaders(testAccount, {
			"x-codex-primary-used-percent": "75",
		});

		const manager2 = new CodexStatusManager();
		const snapshot = await manager2.getSnapshot(testAccount);
		expect(snapshot?.primary?.usedPercent).toBe(75);
	});
});
