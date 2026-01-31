import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CodexStatusManager } from "../lib/codex-status.js";
import { getCachePath } from "../lib/storage.js";
import type { AccountRecordV3 } from "../lib/types.js";

const SNAPSHOT_FIXTURE_PATH = join(__dirname, "fixtures", "codex-status-snapshots.json");
const HEADERS_FIXTURE_PATH = join(__dirname, "fixtures", "codex-headers.json");

describe("CodexStatusManager", () => {
	const mockAccount: AccountRecordV3 = {
		refreshToken: "test-token",
		accountId: "test-id",
		email: "test@example.com",
		plan: "pro",
		addedAt: Date.now(),
		lastUsed: Date.now(),
	};

	beforeEach(() => {
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

	it("parses valid headers and stores snapshot", () => {
		const manager = new CodexStatusManager();
		manager.updateFromHeaders(mockAccount, {
			"x-codex-primary-used-percent": "45.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "123456789",
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-unlimited": "false",
			"x-codex-credits-balance": "15.5",
		});

		const snapshot = manager.getSnapshot(mockAccount);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.primary?.usedPercent).toBe(45.5);
		expect(snapshot?.primary?.windowMinutes).toBe(300);
		expect(snapshot?.credits?.balance).toBe(15.5);
		expect(snapshot?.credits?.unlimited).toBe(false);
	});

	it("clumps usedPercent to 0-100", () => {
		const manager = new CodexStatusManager();
		manager.updateFromHeaders(mockAccount, {
			"x-codex-primary-used-percent": "150",
			"x-codex-secondary-used-percent": "-50",
		});

		const snapshot = manager.getSnapshot(mockAccount);
		expect(snapshot?.primary?.usedPercent).toBe(100);
		expect(snapshot?.secondary?.usedPercent).toBe(0);
	});

	it("tracks staleness", () => {
		vi.useFakeTimers();
		try {
			const manager = new CodexStatusManager();
			manager.updateFromHeaders(mockAccount, {
				"x-codex-primary-used-percent": "10",
			});

			expect(manager.getSnapshot(mockAccount)?.isStale).toBe(false);

			// Advance 16 minutes (TTL is 15)
			vi.advanceTimersByTime(16 * 60 * 1000);
			expect(manager.getSnapshot(mockAccount)?.isStale).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("merges partial headers with existing data", () => {
		const manager = new CodexStatusManager();
		manager.updateFromHeaders(mockAccount, {
			"x-codex-primary-used-percent": "10",
			"x-codex-primary-window-minutes": "300",
		});

		manager.updateFromHeaders(mockAccount, {
			"x-codex-primary-used-percent": "20",
		});

		const snapshot = manager.getSnapshot(mockAccount);
		expect(snapshot?.primary?.usedPercent).toBe(20);
		expect(snapshot?.primary?.windowMinutes).toBe(300); // Preserved from previous update
	});

	it("renders status bars correctly", () => {
		const manager = new CodexStatusManager();
		manager.updateFromHeaders(mockAccount, {
			"x-codex-primary-used-percent": "50",
			"x-codex-primary-window-minutes": "0", // Force Primary label
			"x-codex-secondary-used-percent": "25",
			"x-codex-credits-unlimited": "true",
		});

		const lines = manager.renderStatus(mockAccount);
		// Check for key components rather than exact string formatting which is fragile
		expect(lines.some(l => l.includes("Primary") && l.includes("50.0%"))).toBe(true);
		expect(lines.some(l => l.includes("Weekly") && l.includes("25.0%"))).toBe(true);
		expect(lines.some(l => l.includes("Credits") && l.includes("unlimited"))).toBe(true);
	});

	it("persists snapshots to disk and reloads them", () => {
		const manager1 = new CodexStatusManager();
		manager1.updateFromHeaders(mockAccount, {
			"x-codex-primary-used-percent": "75",
		});

		const manager2 = new CodexStatusManager();
		const snapshot = manager2.getSnapshot(mockAccount);
		expect(snapshot?.primary?.usedPercent).toBe(75);
	});

	it("loads data from fixture and matches snapshots", () => {
		const fixtureData = JSON.parse(readFileSync(SNAPSHOT_FIXTURE_PATH, "utf-8"));
		const cachePath = getCachePath("codex-snapshots.json");
		
		// Seed the cache with fixture data
		writeFileSync(cachePath, JSON.stringify(fixtureData));

		const manager = new CodexStatusManager();
		
		// Account 1 (Plus)
		const account1: AccountRecordV3 = {
			refreshToken: "rt_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0.u1V2w3X4y5Z6a7B8c9D0e1F2g3H4i5J6k7L8m9N0",
			accountId: "1f2e3d4c-5b6a-7980-91a2-b3c4d5e6f708",
			email: "user.one@example.com",
			plan: "Plus",
			addedAt: 0,
			lastUsed: 0,
		};
		const snap1 = manager.getSnapshot(account1);
		expect(snap1?.primary?.usedPercent).toBe(45.5);
		expect(snap1?.secondary?.windowMinutes).toBe(10080);

		// Account 2 (Team)
		const account2: AccountRecordV3 = {
			refreshToken: "rt_B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1.v2W3x4Y5z6A7b8C9d0E1f2G3h4I5j6K7l8M9n0",
			accountId: "c4e5f6a7-8b9c-4d1e-8f2a-3b4c5d6e7f8a",
			email: "user.one@example.com",
			plan: "Team",
			addedAt: 0,
			lastUsed: 0,
		};
		const snap2 = manager.getSnapshot(account2);
		expect(snap2?.primary?.usedPercent).toBe(0);
		expect(snap2?.credits?.balance).toBe(15.5);

		// Account 3 (Team, shared ID)
		const account3: AccountRecordV3 = {
			refreshToken: "rt_C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2.w3X4y5Z6a7B8c9D0e1F2g3H4i5J6k7L8m9N0q1",
			accountId: "c4e5f6a7-8b9c-4d1e-8f2a-3b4c5d6e7f8a",
			email: "user.two@example.com",
			plan: "Team",
			addedAt: 0,
			lastUsed: 0,
		};
		const snap3 = manager.getSnapshot(account3);
		expect(snap3?.primary?.usedPercent).toBe(100);
		expect(snap3?.credits?.unlimited).toBe(true);
	});

	it("updates snapshots correctly from raw header fixture", () => {
		const fixture = JSON.parse(readFileSync(HEADERS_FIXTURE_PATH, "utf-8"));
		const manager = new CodexStatusManager();

		for (const item of fixture.headers) {
			const account: AccountRecordV3 = {
				refreshToken: "mock-token",
				...item.account,
				addedAt: 0,
				lastUsed: 0,
			};
			manager.updateFromHeaders(account, item.raw);
			
			const snapshot = manager.getSnapshot(account);
			expect(snapshot).not.toBeNull();
			expect(snapshot?.primary?.usedPercent).toBe(Number(item.raw["x-codex-primary-used-percent"]));
		}
	});
});
