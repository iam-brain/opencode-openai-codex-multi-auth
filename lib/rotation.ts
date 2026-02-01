/**
 * Account Rotation System
 *
 * Provides the building blocks for the `hybrid` account selection strategy:
 * - Health scoring: prefer accounts that are behaving well
 * - Token bucket: client-side throttling to avoid repeatedly slamming one account
 * - LRU/freshness bias: prefer accounts that have rested longer
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// ACCOUNT IDENTITY
// ---------------------------------------------------------------------------

/**
 * Minimal account identity for tracker keying.
 * Uses accountId + email + plan for stable identity (matches storage conventions).
 * Falls back to refreshToken hash for legacy accounts without full identity.
 */
export interface AccountIdentity {
	accountId?: string;
	email?: string;
	plan?: string;
	refreshToken?: string;
	/** Account index is still needed for hybrid selection return values */
	index?: number;
}

/**
 * Generate a stable key for an account based on its identity.
 * Priority: accountId+email+plan > refreshToken hash > "unknown"
 */
export function getAccountKey(account: AccountIdentity): string {
	if (account.accountId && account.email && account.plan) {
		const email = account.email.toLowerCase();
		const plan = account.plan.toLowerCase();
		return `${account.accountId}|${email}|${plan}`;
	}
	if (account.refreshToken) {
		return createHash("sha256").update(account.refreshToken).digest("hex").substring(0, 16);
	}
	// Last resort: use index if available
	if (typeof account.index === "number") {
		return `idx:${account.index}`;
	}
	return "unknown";
}

// ---------------------------------------------------------------------------
// HEALTH SCORE
// ---------------------------------------------------------------------------

export interface HealthScoreConfig {
	/** Initial score for new accounts (default: 70) */
	initial: number;
	/** Points added on successful request (default: 1) */
	successReward: number;
	/** Points removed on rate limit (default: -10) */
	rateLimitPenalty: number;
	/** Points removed on failure (auth/network/server) (default: -20) */
	failurePenalty: number;
	/** Points recovered per hour of rest (default: 2) */
	recoveryRatePerHour: number;
	/** Minimum score to be considered usable (default: 50) */
	minUsable: number;
	/** Maximum score cap (default: 100) */
	maxScore: number;
	/** Cleanup stale entries after this many ms of inactivity (default: 24 hours) */
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
	private readonly cleanupIntervalMs = 60_000; // Cleanup check every minute

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

	/** For testing: get the number of tracked accounts */
	size(): number {
		return this.scores.size;
	}
}

// ---------------------------------------------------------------------------
// TOKEN BUCKET
// ---------------------------------------------------------------------------

export interface TokenBucketConfig {
	/** Maximum tokens per account (default: 50) */
	maxTokens: number;
	/** Tokens regenerated per minute (default: 6) */
	regenerationRatePerMinute: number;
	/** Initial tokens for new accounts (default: 50) */
	initialTokens: number;
	/** Cleanup stale entries after this many ms of inactivity (default: 1 hour) */
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
	private readonly cleanupIntervalMs = 60_000; // Cleanup check every minute

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

	/** For testing: get the number of tracked accounts */
	size(): number {
		return this.buckets.size;
	}
}

// ---------------------------------------------------------------------------
// HYBRID SELECTION
// ---------------------------------------------------------------------------

export interface AccountWithMetrics extends AccountIdentity {
	index: number;
	lastUsed: number;
	healthScore: number;
	isRateLimited: boolean;
	isCoolingDown: boolean;
}

const STICKINESS_BONUS = 150;
const SWITCH_THRESHOLD = 100;

export function selectHybridAccount(
	accounts: AccountWithMetrics[],
	tokenTracker: TokenBucketTracker,
	currentAccountIndex: number | null = null,
	minHealthScore = 50,
): number | null {
	const candidates = accounts
		.filter(
			(acc) =>
				!acc.isRateLimited &&
				!acc.isCoolingDown &&
				acc.healthScore >= minHealthScore &&
				tokenTracker.hasTokens(acc),
		)
		.map((acc) => ({ ...acc, tokens: tokenTracker.getTokens(acc) }));

	if (candidates.length === 0) return null;

	const maxTokens = tokenTracker.getMaxTokens();
	const scored = candidates
		.map((acc) => {
			const base = calculateHybridScore(acc, maxTokens);
			const isCurrent = currentAccountIndex !== null && acc.index === currentAccountIndex;
			const score = base + (isCurrent ? STICKINESS_BONUS : 0);
			return { index: acc.index, score, base, isCurrent };
		})
		.sort((a, b) => b.score - a.score);

	const best = scored[0];
	const current = scored.find((item) => item.isCurrent);
	if (current && best && !best.isCurrent && best.base - current.base < SWITCH_THRESHOLD) {
		return current.index;
	}

	return best?.index ?? null;
}

function calculateHybridScore(
	account: AccountWithMetrics & { tokens: number },
	maxTokens: number,
): number {
	const healthComponent = account.healthScore * 2;
	const tokenComponent = (account.tokens / maxTokens) * 100 * 5;
	const secondsSinceUsed = (Date.now() - account.lastUsed) / 1000;
	const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;
	return Math.max(0, healthComponent + tokenComponent + freshnessComponent);
}

// ---------------------------------------------------------------------------
// SINGLETONS
// ---------------------------------------------------------------------------

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
