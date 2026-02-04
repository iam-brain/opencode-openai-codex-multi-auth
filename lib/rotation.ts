/**
 * Account Rotation System
 *
 * Building blocks for `hybrid` selection:
 * - Health scoring: prefer behaving accounts
 * - Token bucket: client-side throttling
 * - LRU/freshness: prefer rested accounts
 */

import { createHash } from "node:crypto";

export interface AccountIdentity {
	accountId?: string;
	email?: string;
	plan?: string;
	refreshToken?: string;
	index?: number;
}

export function getAccountKey(account: AccountIdentity): string {
	if (account.accountId && account.email && account.plan) {
		const email = account.email.toLowerCase();
		const plan = account.plan.toLowerCase();
		return `${account.accountId}|${email}|${plan}`;
	}
	if (account.refreshToken) {
		return createHash("sha256").update(account.refreshToken).digest("hex").substring(0, 16);
	}
	if (typeof account.index === "number") {
		return `idx:${account.index}`;
	}
	return "unknown";
}

export interface HealthScoreConfig {
	initial: number;
	successReward: number;
	rateLimitPenalty: number;
	failurePenalty: number;
	recoveryRatePerHour: number;
	minUsable: number;
	maxScore: number;
	staleAfterMs: number;
}

export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
	initial: 70,
	successReward: 1,
	rateLimitPenalty: -10,
	failurePenalty: -20,
	recoveryRatePerHour: 2,
	minUsable: 50,
	maxScore: 100,
	staleAfterMs: 24 * 60 * 60 * 1000, // 24 hours
};

export interface HealthScoreState {
	score: number;
	lastUpdated: number;
	consecutiveFailures: number;
}

export class HealthScoreTracker {
	private readonly scores = new Map<string, HealthScoreState>();
	private readonly config: HealthScoreConfig;
	private lastCleanup = 0;
	private readonly cleanupIntervalMs = 60_000;

	constructor(config: Partial<HealthScoreConfig> = {}, initialScores: Record<string, HealthScoreState> = {}) {
		this.config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...config };
		for (const [key, state] of Object.entries(initialScores)) {
			this.scores.set(key, state);
		}
	}

	getScores(): Record<string, HealthScoreState> {
		this.cleanup();
		return Object.fromEntries(this.scores.entries());
	}

	private cleanup(): void {
		const now = Date.now();
		if (now - this.lastCleanup < this.cleanupIntervalMs) return;
		this.lastCleanup = now;

		for (const [key, state] of this.scores) {
			if (now - state.lastUpdated > this.config.staleAfterMs) {
				this.scores.delete(key);
			}
		}
	}

	getScore(account: AccountIdentity): number {
		this.cleanup();
		const key = getAccountKey(account);
		const state = this.scores.get(key);
		if (!state) return this.config.initial;

		const now = Date.now();
		const hoursSinceUpdate = (now - state.lastUpdated) / (1000 * 60 * 60);
		const recovered = Math.floor(hoursSinceUpdate * this.config.recoveryRatePerHour);

		return Math.min(this.config.maxScore, state.score + recovered);
	}

	isUsable(account: AccountIdentity): boolean {
		return this.getScore(account) >= this.config.minUsable;
	}

	recordSuccess(account: AccountIdentity): void {
		this.cleanup();
		const key = getAccountKey(account);
		const now = Date.now();
		const current = this.getScore(account);
		this.scores.set(key, {
			score: Math.min(this.config.maxScore, current + this.config.successReward),
			lastUpdated: now,
			consecutiveFailures: 0,
		});
	}

	recordRateLimit(account: AccountIdentity): void {
		this.cleanup();
		const key = getAccountKey(account);
		const now = Date.now();
		const previous = this.scores.get(key);
		const current = this.getScore(account);
		this.scores.set(key, {
			score: Math.max(0, current + this.config.rateLimitPenalty),
			lastUpdated: now,
			consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
		});
	}

	recordFailure(account: AccountIdentity): void {
		this.cleanup();
		const key = getAccountKey(account);
		const now = Date.now();
		const previous = this.scores.get(key);
		const current = this.getScore(account);
		this.scores.set(key, {
			score: Math.max(0, current + this.config.failurePenalty),
			lastUpdated: now,
			consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
		});
	}

	size(): number {
		return this.scores.size;
	}
}

export interface TokenBucketConfig {
	maxTokens: number;
	regenerationRatePerMinute: number;
	initialTokens: number;
	staleAfterMs: number;
}

export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
	maxTokens: 50,
	regenerationRatePerMinute: 6,
	initialTokens: 50,
	staleAfterMs: 60 * 60 * 1000, // 1 hour
};

export interface TokenBucketState {
	tokens: number;
	lastUpdated: number;
}

export class TokenBucketTracker {
	private readonly buckets = new Map<string, TokenBucketState>();
	private readonly config: TokenBucketConfig;
	private lastCleanup = 0;
	private readonly cleanupIntervalMs = 60_000;

	constructor(config: Partial<TokenBucketConfig> = {}, initialBuckets: Record<string, TokenBucketState> = {}) {
		this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
		for (const [key, state] of Object.entries(initialBuckets)) {
			this.buckets.set(key, state);
		}
	}

	getBuckets(): Record<string, TokenBucketState> {
		this.cleanup();
		return Object.fromEntries(this.buckets.entries());
	}

	private cleanup(): void {
		const now = Date.now();
		if (now - this.lastCleanup < this.cleanupIntervalMs) return;
		this.lastCleanup = now;

		for (const [key, state] of this.buckets) {
			if (now - state.lastUpdated > this.config.staleAfterMs) {
				this.buckets.delete(key);
			}
		}
	}

	getTokens(account: AccountIdentity): number {
		this.cleanup();
		const key = getAccountKey(account);
		const state = this.buckets.get(key);
		if (!state) return this.config.initialTokens;

		const now = Date.now();
		const minutesSinceUpdate = (now - state.lastUpdated) / (1000 * 60);
		const recovered = minutesSinceUpdate * this.config.regenerationRatePerMinute;
		return Math.min(this.config.maxTokens, state.tokens + recovered);
	}

	hasTokens(account: AccountIdentity, cost = 1): boolean {
		return this.getTokens(account) >= cost;
	}

	consume(account: AccountIdentity, cost = 1): boolean {
		this.cleanup();
		const key = getAccountKey(account);
		const current = this.getTokens(account);
		if (current < cost) return false;
		this.buckets.set(key, {
			tokens: current - cost,
			lastUpdated: Date.now(),
		});
		return true;
	}

	refund(account: AccountIdentity, amount = 1): void {
		this.cleanup();
		const key = getAccountKey(account);
		const current = this.getTokens(account);
		this.buckets.set(key, {
			tokens: Math.min(this.config.maxTokens, current + amount),
			lastUpdated: Date.now(),
		});
	}

	getMaxTokens(): number {
		return this.config.maxTokens;
	}

	size(): number {
		return this.buckets.size;
	}
}

export interface AccountWithMetrics extends AccountIdentity {
	index: number;
	lastUsed: number;
	healthScore: number;
	isRateLimited: boolean;
	isCoolingDown: boolean;
}

/**
 * Selects account by health score, token availability, then LRU.
 */
export function selectHybridAccount(
	accounts: AccountWithMetrics[],
	tokenTracker: TokenBucketTracker,
	_currentAccountIndex: number | null = null,
	minHealthScore = 50,
): number | null {
	const candidates = accounts
		.filter(
			(acc) =>
				!acc.isCoolingDown &&
				!acc.isRateLimited &&
				acc.healthScore >= minHealthScore &&
				tokenTracker.hasTokens(acc),
		)
		.map((acc) => ({ ...acc, tokens: tokenTracker.getTokens(acc) }));

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => {
		if (b.healthScore !== a.healthScore) return b.healthScore - a.healthScore;
		if (b.tokens !== a.tokens) return b.tokens - a.tokens;
		if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
		return a.index - b.index;
	});

	return candidates[0]?.index ?? null;
}

let globalTokenTracker: TokenBucketTracker | null = null;

export function getTokenTracker(): TokenBucketTracker {
	if (!globalTokenTracker) globalTokenTracker = new TokenBucketTracker();
	return globalTokenTracker;
}

let globalHealthTracker: HealthScoreTracker | null = null;

export function getHealthTracker(): HealthScoreTracker {
	if (!globalHealthTracker) globalHealthTracker = new HealthScoreTracker();
	return globalHealthTracker;
}
