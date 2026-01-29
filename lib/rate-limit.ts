import type { SchedulingMode } from "./types.js";

export type RateLimitReason = "capacity" | "quota" | "rate-limit" | "unknown";

export interface RateLimitBackoff {
	delayMs: number;
	attempt: number;
	isDuplicate: boolean;
}

export interface RateLimitDecisionInput {
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
	const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : options.defaultRetryMs;
	let multiplier = 1;
	if (reason === "capacity" || reason === "rate-limit") {
		multiplier = Math.min(6, Math.max(1, attempt));
	} else if (reason === "quota") {
		multiplier = Math.min(12, Math.max(1, attempt));
	}
	let delay = base * multiplier;
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

	if (options.switchOnFirstRateLimit && attempt <= 1) {
		return { action: "switch", delayMs };
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

	constructor(options: RateLimitTrackerOptions) {
		this.options = options;
	}

	getBackoff(
		key: string,
		reason: RateLimitReason,
		retryAfterMs: number | null,
	): RateLimitBackoff {
		const now = Date.now();
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
