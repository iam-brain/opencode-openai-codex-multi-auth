import type { Auth, Provider, Model } from "@opencode-ai/sdk";

/**
 * Plugin configuration from ~/.config/opencode/openai-codex-auth-config.json
 */
export interface PluginConfig {
	/**
	 * Legacy toggle for bridge mode.
	 * Deprecated: bridge injection has been removed and this flag no longer changes runtime behavior.
	 * @default false
	 */
	codexMode?: boolean;

	/**
	 * Account selection strategy
	 * - sticky: keep same account until rate-limited (best for caching)
	 * - round-robin: rotate accounts on every request (best for throughput)
	 * - hybrid: balance health score, token bucket, and freshness
	 * @default "sticky"
	 */
	accountSelectionStrategy?: AccountSelectionStrategy;

	/**
	 * Enable PID-based account offset for parallel agents.
	 * Note: Only meaningful when 2+ accounts exist.
	 * @default true
	 */
	pidOffsetEnabled?: boolean;

	/**
	 * Suppress toast notifications.
	 * @default false
	 */
	quietMode?: boolean;

	/**
	 * Store accounts per-project when a repo-local accounts file exists.
	 * @default false
	 */
	perProjectAccounts?: boolean;

	/**
	 * Proactive refresh skew (ms).
	 * @default 60000
	 */
	tokenRefreshSkewMs?: number;

	/**
	 * Enable proactive token refresh.
	 * @default false
	 */
	proactiveTokenRefresh?: boolean;

	/**
	 * Enable auth debug logging.
	 * @default false
	 */
	authDebug?: boolean;

	/**
	 * Toast debounce interval (ms).
	 * @default 60000
	 */
	rateLimitToastDebounceMs?: number;

	/**
	 * Scheduling mode for rate-limit handling.
	 * @default "cache_first"
	 */
	schedulingMode?: SchedulingMode;

	/**
	 * Max cache-first wait (seconds).
	 * @default 60
	 */
	maxCacheFirstWaitSeconds?: number;

	/**
	 * Switch accounts on first rate limit when possible.
	 * @default true
	 */
	switchOnFirstRateLimit?: boolean;

	/**
	 * Rate-limit dedup window (ms).
	 * @default 2000
	 */
	rateLimitDedupWindowMs?: number;

	/**
	 * Rate-limit reset delay (ms).
	 * @default 120000
	 */
	rateLimitStateResetMs?: number;

	/**
	 * Default retry delay (ms).
	 * @default 60000
	 */
	defaultRetryAfterMs?: number;

	/**
	 * Max backoff delay (ms).
	 * @default 120000
	 */
	maxBackoffMs?: number;

	/**
	 * Max request jitter (ms).
	 * @default 1000
	 */
	requestJitterMaxMs?: number;

	/**
	 * Retry when all accounts rate-limited.
	 * @default false
	 */
	retryAllAccountsRateLimited?: boolean;

	/**
	 * Max retry wait (ms).
	 * Set to 0 to disable wait limit.
	 * @default 30000
	 */
	retryAllAccountsMaxWaitMs?: number;

	/**
	 * Max retry attempts.
	 * @default 1
	 */
	retryAllAccountsMaxRetries?: number;
}

export type AccountSelectionStrategy = "sticky" | "round-robin" | "hybrid";

export type SchedulingMode = "cache_first" | "balance" | "performance_first";

export type OAuthAuthDetails = Extract<Auth, { type: "oauth" }>;

export type CooldownReason = "auth-failure";

export type RateLimitStateV3 = Record<string, number | undefined>;

export interface AccountRecordV3 {
	refreshToken: string;
	accountId?: string;
	email?: string;
	plan?: string;
	enabled?: boolean;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	rateLimitResetTimes?: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountStorageV3 {
	version: 3;
	accounts: AccountRecordV3[];
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<string, number>>;
}

/**
 * User config structure
 */
export interface UserConfig {
	global: ConfigOptions;
	models: {
		[modelName: string]: {
			options?: ConfigOptions;
			variants?: Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>;
			[key: string]: unknown;
		};
	};
}

/**
 * Reasoning/text options
 */
export interface ConfigOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	personality?: "none" | "friendly" | "pragmatic";
	include?: string[];
}

/**
 * Reasoning config
 */
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed" | "off" | "on";
}

/**
 * OAuth server info
 */
export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

/**
 * PKCE pair
 */
export interface PKCEPair {
	challenge: string;
	verifier: string;
}

/**
 * Auth flow result
 */
export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

/**
 * Token success result
 */
export interface TokenSuccess {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
	idToken?: string;
	headers?: Headers;
}

/**
 * Token failure result
 */
export interface TokenFailure {
	type: "failed";
}

/**
 * Token result
 */
export type TokenResult = TokenSuccess | TokenFailure;

/**
 * Parsed auth input
 */
export interface ParsedAuthInput {
	code?: string;
	state?: string;
}

/**
 * JWT payload
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
}

/**
 * Input item
 */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Request body
 */
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	providerOptions?: {
		openai?: Partial<ConfigOptions> & { store?: boolean; include?: string[] };
		[key: string]: unknown;
	};
	/** Stable key to enable prompt-token caching on Codex backend */
	prompt_cache_key?: string;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

/**
 * /wham/usage response
 */
export interface CodexWhamUsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: {
			used_percent: number;
			limit_window_seconds: number;
			reset_at: number;
		};
		secondary_window?: {
			used_percent: number;
			limit_window_seconds: number;
			reset_at: number;
		};
	};
	credits?: {
		has_credits: boolean;
		unlimited: boolean;
		balance: string;
	};
}

/**
 * SSE event data
 */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/**
 * Cache metadata
 */
export interface CacheMetadata {
	etag: string | null;
	tag: string;
	lastChecked: number;
	url: string;
}

/**
 * GitHub release
 */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

// Re-export SDK types for convenience
export type { Auth, Provider, Model };
