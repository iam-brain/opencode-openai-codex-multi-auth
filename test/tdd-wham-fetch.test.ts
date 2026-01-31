import { describe, expect, it, vi, beforeEach } from "vitest";
import { CodexStatusManager } from "../lib/codex-status.js";
import type { AccountRecordV3 } from "../lib/types.js";

describe("TDD: Codex Status Backend Fetching", () => {
	const mockAccount: AccountRecordV3 = {
		refreshToken: "test-token",
		accountId: "user-test-id",
		email: "bfont39@live.com",
		plan: "Plus",
		addedAt: Date.now(),
		lastUsed: Date.now(),
	};

	beforeEach(async () => {
		vi.resetAllMocks();
		// Clear cache between tests
		const { getCachePath } = await import("../lib/storage.js");
		const cachePath = getCachePath("codex-snapshots.json");
		const fs = await import("node:fs");
		if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
	});

	it("correctly parses /wham/usage JSON response", async () => {
		const manager = new CodexStatusManager();
		
		// Mock global fetch
		const mockResponse = {
			plan_type: "plus",
			rate_limit: {
				primary_window: {
					used_percent: 42.5,
					limit_window_seconds: 18000,
					reset_at: 1769862948
				},
				secondary_window: {
					used_percent: 88.0,
					limit_window_seconds: 604800,
					reset_at: 1770129140
				}
			},
			credits: {
				has_credits: true,
				unlimited: false,
				balance: "15.50"
			}
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse
		});

		await manager.fetchFromBackend(mockAccount, "test.jwt.token");

		const snapshot = await manager.getSnapshot(mockAccount);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.primary?.usedPercent).toBe(42.5);
		expect(snapshot?.primary?.windowMinutes).toBe(300); // 18000 / 60
		expect(snapshot?.secondary?.usedPercent).toBe(88.0);
		expect(snapshot?.secondary?.windowMinutes).toBe(10080); // 604800 / 60
		expect(snapshot?.credits?.balance).toBe("15.50");
	});

	it("handles missing limits in /wham/usage gracefully", async () => {
		const manager = new CodexStatusManager();
		
		const mockResponse = {
			plan_type: "free",
			rate_limit: {
				primary_window: null,
				secondary_window: null
			}
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse
		});

		await manager.fetchFromBackend(mockAccount, "test.jwt.token");

		const lines = await manager.renderStatus(mockAccount);
		// It should always render both lines, even if data is missing
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0]).toContain("Primary"); // Label defaults to Primary if no windowMinutes
		expect(lines[0]).toContain("unknown");
	});
});
