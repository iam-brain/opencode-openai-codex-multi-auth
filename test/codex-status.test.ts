import { describe, expect, it, vi } from "vitest";
import { CodexStatusManager } from "../lib/codex-status.js";
import type { AccountRecordV3 } from "../lib/types.js";

describe("CodexStatusManager", () => {
	const mockAccount: AccountRecordV3 = {
		refreshToken: "test-token",
		accountId: "test-id",
		email: "test@example.com",
		plan: "pro",
		addedAt: Date.now(),
		lastUsed: Date.now(),
	};

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
});
