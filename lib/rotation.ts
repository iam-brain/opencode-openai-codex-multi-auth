/**
 * Account Rotation System
 *
 * Provides the building blocks for the `hybrid` account selection strategy:
 * - Health scoring: prefer accounts that are behaving well
 * - Token bucket: client-side throttling to avoid repeatedly slamming one account
 * - LRU/freshness bias: prefer accounts that have rested longer
 */

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
}

export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
	initial: 70,
	successReward: 1,
	rateLimitPenalty: -10,
	failurePenalty: -20,
	recoveryRatePerHour: 2,
	minUsable: 50,
	maxScore: 100,
};

interface HealthScoreState {
	score: number;
	lastUpdated: number;
	consecutiveFailures: number;
}

export class HealthScoreTracker {
	private readonly scores = new Map<number, HealthScoreState>();
	private readonly config: HealthScoreConfig;

	constructor(config: Partial<HealthScoreConfig> = {}) {
		this.config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...config };
	}

	getScore(accountIndex: number): number {
		const state = this.scores.get(accountIndex);
		if (!state) return this.config.initial;

		const now = Date.now();
		const hoursSinceUpdate = (now - state.lastUpdated) / (1000 * 60 * 60);
		const recovered = Math.floor(hoursSinceUpdate * this.config.recoveryRatePerHour);

		return Math.min(this.config.maxScore, state.score + recovered);
	}

	isUsable(accountIndex: number): boolean {
		return this.getScore(accountIndex) >= this.config.minUsable;
	}

	recordSuccess(accountIndex: number): void {
		const now = Date.now();
		const current = this.getScore(accountIndex);
		this.scores.set(accountIndex, {
			score: Math.min(this.config.maxScore, current + this.config.successReward),
			lastUpdated: now,
			consecutiveFailures: 0,
		});
	}

	recordRateLimit(accountIndex: number): void {
		const now = Date.now();
		const previous = this.scores.get(accountIndex);
		const current = this.getScore(accountIndex);
		this.scores.set(accountIndex, {
			score: Math.max(0, current + this.config.rateLimitPenalty),
			lastUpdated: now,
			consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
		});
	}

	recordFailure(accountIndex: number): void {
		const now = Date.now();
		const previous = this.scores.get(accountIndex);
		const current = this.getScore(accountIndex);
		this.scores.set(accountIndex, {
			score: Math.max(0, current + this.config.failurePenalty),
			lastUpdated: now,
			consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
		});
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
}

export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
	maxTokens: 50,
	regenerationRatePerMinute: 6,
	initialTokens: 50,
};

interface TokenBucketState {
	tokens: number;
	lastUpdated: number;
}

export class TokenBucketTracker {
	private readonly buckets = new Map<number, TokenBucketState>();
	private readonly config: TokenBucketConfig;

	constructor(config: Partial<TokenBucketConfig> = {}) {
		this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
	}

	getTokens(accountIndex: number): number {
		const state = this.buckets.get(accountIndex);
		if (!state) return this.config.initialTokens;

		const now = Date.now();
		const minutesSinceUpdate = (now - state.lastUpdated) / (1000 * 60);
		const recovered = minutesSinceUpdate * this.config.regenerationRatePerMinute;
		return Math.min(this.config.maxTokens, state.tokens + recovered);
	}

	hasTokens(accountIndex: number, cost = 1): boolean {
		return this.getTokens(accountIndex) >= cost;
	}

	consume(accountIndex: number, cost = 1): boolean {
		const current = this.getTokens(accountIndex);
		if (current < cost) return false;
		this.buckets.set(accountIndex, {
			tokens: current - cost,
			lastUpdated: Date.now(),
		});
		return true;
	}

	refund(accountIndex: number, amount = 1): void {
		const current = this.getTokens(accountIndex);
		this.buckets.set(accountIndex, {
			tokens: Math.min(this.config.maxTokens, current + amount),
			lastUpdated: Date.now(),
		});
	}

	getMaxTokens(): number {
		return this.config.maxTokens;
	}
}

// ---------------------------------------------------------------------------
// HYBRID SELECTION
// ---------------------------------------------------------------------------

export interface AccountWithMetrics {
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
				tokenTracker.hasTokens(acc.index),
		)
		.map((acc) => ({ ...acc, tokens: tokenTracker.getTokens(acc.index) }));

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
