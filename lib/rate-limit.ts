import type { SchedulingMode } from "./types.js";

export type RateLimitReason = "capacity" | "quota" | "rate-limit" | "unknown";

export interface RateLimitBackoff {
	delayMs: number;
	attempt: number;
	isDuplicate: boolean;
}

export interface RateLimitDecisionInput {
	reason: RateLimitReason;
	schedulingMode: SchedulingMode;
	accountCount: number;
	maxCacheFirstWaitMs: number;
	switchOnFirstRateLimit: boolean;
	shortRetryThresholdMs: number;
	backoff: RateLimitBackoff;
}

export interface RateLimitDecision {
	action: "wait" | "switch";
	delayMs: number;
}

export interface RateLimitTrackerOptions {
	dedupWindowMs: number;
	resetMs: number;
	defaultRetryMs: number;
	maxBackoffMs: number;
	jitterMaxMs: number;
}

type RateLimitState = {
	lastAt: number;
	consecutive: number;
	lastDelayMs: number;
};

export function parseRateLimitReason(
	status: number,
	bodyText: string | null | undefined,
): RateLimitReason {
	if (status === 503 || status === 529) return "capacity";
	const haystack = (bodyText ?? "").toLowerCase();
	if (/capacity|overloaded|server\s+busy|service\s+unavailable/.test(haystack)) {
		return "capacity";
	}
	if (/quota|usage\s+limit|billing|insufficient/.test(haystack)) {
		return "quota";
	}
	if (/rate\s+limit|too\s+many\s+requests/.test(haystack)) {
		return "rate-limit";
	}
	return "unknown";
}

export function calculateBackoffMs(
	reason: RateLimitReason,
	attempt: number,
	retryAfterMs: number | null,
	options: Pick<RateLimitTrackerOptions, "defaultRetryMs" | "maxBackoffMs" | "jitterMaxMs">,
): number {
	const hasRetryAfter = retryAfterMs !== null && retryAfterMs > 0;
	const base = hasRetryAfter ? retryAfterMs : options.defaultRetryMs;
	const pow = Math.max(0, Math.floor(attempt) - 1);
	let delay = base * Math.pow(2, pow);
	if (reason === "quota" && !hasRetryAfter && options.maxBackoffMs > 0) {
		delay = Math.max(delay, options.maxBackoffMs);
	}
	if (options.maxBackoffMs > 0) delay = Math.min(delay, options.maxBackoffMs);
	if (options.jitterMaxMs > 0) {
		delay += Math.floor(Math.random() * options.jitterMaxMs);
	}
	return Math.max(0, Math.floor(delay));
}

export function decideRateLimitAction(options: RateLimitDecisionInput): RateLimitDecision {
	const delayMs = Math.max(0, Math.floor(options.backoff.delayMs));
	const attempt = Math.max(1, Math.floor(options.backoff.attempt));
	const accountCount = Math.max(0, Math.floor(options.accountCount));
	if (accountCount <= 1) {
		return { action: "wait", delayMs };
	}

	if (options.reason === "quota") {
		return { action: "switch", delayMs };
	}

	if (options.switchOnFirstRateLimit && attempt <= 1 && options.reason !== "capacity") {
		return { action: "switch", delayMs };
	}

	if (options.reason === "capacity") {
		const shortThreshold = Math.max(0, Math.floor(options.shortRetryThresholdMs));
		if (delayMs <= shortThreshold) return { action: "wait", delayMs };
	}

	switch (options.schedulingMode) {
		case "performance_first":
			return { action: "switch", delayMs };
		case "cache_first": {
			const maxWait = Math.max(0, Math.floor(options.maxCacheFirstWaitMs));
			if (delayMs <= maxWait) return { action: "wait", delayMs };
			return { action: "switch", delayMs };
		}
		case "balance":
		default: {
			const shortThreshold = Math.max(0, Math.floor(options.shortRetryThresholdMs));
			if (delayMs <= shortThreshold) return { action: "wait", delayMs };
			return { action: "switch", delayMs };
		}
	}
}

export class RateLimitTracker {
	private readonly state = new Map<string, RateLimitState>();
	private readonly options: RateLimitTrackerOptions;
	private lastCleanup = 0;
	private readonly cleanupIntervalMs = 60_000; // Cleanup every minute

	constructor(options: RateLimitTrackerOptions) {
		this.options = options;
	}

	private cleanup(): void {
		const now = Date.now();
		if (now - this.lastCleanup < this.cleanupIntervalMs) return;
		this.lastCleanup = now;

		// Remove entries that have been reset (older than resetMs)
		for (const [key, value] of this.state) {
			if (now - value.lastAt > this.options.resetMs) {
				this.state.delete(key);
			}
		}
	}

	getBackoff(
		key: string,
		reason: RateLimitReason,
		retryAfterMs: number | null,
	): RateLimitBackoff {
		const now = Date.now();
		this.cleanup(); // Periodic cleanup to prevent unbounded growth

		const current = this.state.get(key);
		if (current && now - current.lastAt < this.options.dedupWindowMs) {
			return {
				delayMs: current.lastDelayMs,
				attempt: current.consecutive,
				isDuplicate: true,
			};
		}

		const reset = !current || now - current.lastAt > this.options.resetMs;
		const attempt = reset ? 1 : current.consecutive + 1;
		const delayMs = calculateBackoffMs(reason, attempt, retryAfterMs, this.options);
		this.state.set(key, { lastAt: now, consecutive: attempt, lastDelayMs: delayMs });
		return { delayMs, attempt, isDuplicate: false };
	}
}
