import { readFileSync } from "node:fs";
import { join } from "node:path";
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

	it("correctly parses /wham/usage JSON response and renders 'left' percentage", async () => {
		const manager = new CodexStatusManager();
		
		const fixturePath = join(__dirname, "fixtures", "wham-usage.json");
		const mockResponse = JSON.parse(readFileSync(fixturePath, "utf-8"));

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse
		});

		await manager.fetchFromBackend(mockAccount, "test.jwt.token");

		const snapshot = await manager.getSnapshot(mockAccount);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.primary?.usedPercent).toBe(25.0);
		
		const lines = await manager.renderStatus(mockAccount);
		console.log("\n--- RENDERING: WHAM FETCH ---");
		lines.forEach(l => console.log(l));

		// 100 - 25 = 75% left
		expect(lines[0]).toContain("75% left");
		expect(lines[0]).toContain("5 hour limit:");
		// 100 - 10 = 90% left
		expect(lines[1]).toContain("90% left");
		expect(lines[1]).toContain("Weekly limit:");
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
		expect(lines[0]).toContain("5 hour limit:"); 
		expect(lines[0]).toContain("unknown");
	});
});
