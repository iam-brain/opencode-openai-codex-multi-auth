import { describe, expect, it, vi } from "vitest";

import { RateLimitTracker, decideRateLimitAction } from "../lib/rate-limit.js";

describe("rate limit tracker", () => {
	it("deduplicates within window", () => {
		const tracker = new RateLimitTracker({
			dedupWindowMs: 2000,
			resetMs: 120_000,
			defaultRetryMs: 60_000,
			maxBackoffMs: 120_000,
			jitterMaxMs: 0,
		});
		const first = tracker.getBackoff("acct:codex", "rate-limit", 10_000);
		const second = tracker.getBackoff("acct:codex", "rate-limit", 10_000);
		expect(second.isDuplicate).toBe(true);
		expect(second.delayMs).toBe(first.delayMs);
		expect(second.attempt).toBe(first.attempt);
	});

	it("resets attempts after reset window", () => {
		vi.useFakeTimers();
		try {
			const tracker = new RateLimitTracker({
				dedupWindowMs: 2000,
				resetMs: 120_000,
				defaultRetryMs: 60_000,
				maxBackoffMs: 120_000,
				jitterMaxMs: 0,
			});
			const first = tracker.getBackoff("acct:codex", "rate-limit", 10_000);
			vi.advanceTimersByTime(121_000);
			const second = tracker.getBackoff("acct:codex", "rate-limit", 10_000);
			expect(second.attempt).toBe(1);
			expect(second.isDuplicate).toBe(false);
			expect(first.delayMs).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("rate limit scheduling", () => {
	it("cache_first waits same account under threshold", () => {
		const decision = decideRateLimitAction({
			schedulingMode: "cache_first",
			maxCacheFirstWaitMs: 60_000,
			switchOnFirstRateLimit: false,
			shortRetryThresholdMs: 5_000,
			accountCount: 2,
			backoff: { delayMs: 10_000, attempt: 1, isDuplicate: false },
		});
		expect(decision.action).toBe("wait");
	});

	it("cache_first switches when delay exceeds threshold", () => {
		const decision = decideRateLimitAction({
			schedulingMode: "cache_first",
			maxCacheFirstWaitMs: 5_000,
			switchOnFirstRateLimit: false,
			shortRetryThresholdMs: 5_000,
			accountCount: 2,
			backoff: { delayMs: 10_000, attempt: 1, isDuplicate: false },
		});
		expect(decision.action).toBe("switch");
	});
});
