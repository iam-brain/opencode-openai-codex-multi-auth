import { describe, expect, it, vi } from "vitest";

import { RateLimitTracker, decideRateLimitAction, calculateBackoffMs } from "../lib/rate-limit.js";

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

	it("calculates exponential backoff for repeated rate limits", () => {
		const options = {
			defaultRetryMs: 1000,
			maxBackoffMs: 120_000,
			jitterMaxMs: 0,
		};
		const first = calculateBackoffMs("rate-limit", 1, null, options);
		const second = calculateBackoffMs("rate-limit", 2, null, options);
		const third = calculateBackoffMs("rate-limit", 3, null, options);
		expect(first).toBe(1000);
		expect(second).toBe(2000);
		expect(third).toBe(4000);
	});

	it("uses max backoff for quota without retry-after", () => {
		const options = {
			defaultRetryMs: 1000,
			maxBackoffMs: 120_000,
			jitterMaxMs: 0,
		};
		const delay = calculateBackoffMs("quota", 1, null, options);
		expect(delay).toBe(120_000);
	});
});

describe("rate limit scheduling", () => {
	it("cache_first waits same account under threshold", () => {
		const decision = decideRateLimitAction({
			reason: "rate-limit",
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
			reason: "rate-limit",
			schedulingMode: "cache_first",
			maxCacheFirstWaitMs: 5_000,
			switchOnFirstRateLimit: false,
			shortRetryThresholdMs: 5_000,
			accountCount: 2,
			backoff: { delayMs: 10_000, attempt: 1, isDuplicate: false },
		});
		expect(decision.action).toBe("switch");
	});

	it("quota always switches when multiple accounts", () => {
		const decision = decideRateLimitAction({
			reason: "quota",
			schedulingMode: "cache_first",
			maxCacheFirstWaitMs: 60_000,
			switchOnFirstRateLimit: false,
			shortRetryThresholdMs: 5_000,
			accountCount: 2,
			backoff: { delayMs: 1000, attempt: 1, isDuplicate: false },
		});
		expect(decision.action).toBe("switch");
	});

	it("capacity waits on short delays even with switch-on-first", () => {
		const decision = decideRateLimitAction({
			reason: "capacity",
			schedulingMode: "performance_first",
			maxCacheFirstWaitMs: 60_000,
			switchOnFirstRateLimit: true,
			shortRetryThresholdMs: 5_000,
			accountCount: 2,
			backoff: { delayMs: 1000, attempt: 1, isDuplicate: false },
		});
		expect(decision.action).toBe("wait");
	});
});
