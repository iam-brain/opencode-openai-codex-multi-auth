import { describe, expect, it } from "vitest";

import { TokenBucketTracker, selectHybridAccount } from "../lib/rotation.js";

describe("hybrid rotation", () => {
	it("keeps current account when advantage is small", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();
		const accounts = [
			{
				index: 0,
				lastUsed: now - 10_000,
				healthScore: 70,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(0);
	});

	it("switches when another account is far better", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();
		const accounts = [
			{
				index: 0,
				lastUsed: now - 10_000,
				healthScore: 40,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				lastUsed: now - 10_000,
				healthScore: 95,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(1);
	});
});
