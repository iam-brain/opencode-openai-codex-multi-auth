import type { Auth, Provider, Model } from "@opencode-ai/sdk";

/**
 * Plugin configuration from ~/.opencode/openai-codex-auth-config.json
 */
export interface PluginConfig {
	/**
	 * Enable CODEX_MODE (Codex-OpenCode bridge prompt instead of tool remap)
	 * @default true
	 */
	codexMode?: boolean;

	/**
	 * Account selection strategy when multiple accounts are configured.
	 * - sticky: keep the same account until rate-limited (best for caching)
	 * - round-robin: rotate accounts on every request (best for throughput)
	 * @default "sticky"
	 */
	accountSelectionStrategy?: AccountSelectionStrategy;

	/**
	 * Enable PID-based account offset for parallel agents.
	 * When enabled, each process chooses a different starting account but remains sticky.
	 *
	 * Note: This is only meaningful when 2+ accounts exist.
	 * @default true
	 */
	pidOffsetEnabled?: boolean;

	/**
	 * Suppress most toast notifications.
	 * @default false
	 */
	quietMode?: boolean;

	/**
	 * Milliseconds before token expiry to proactively refresh.
	 * @default 60000
	 */
	tokenRefreshSkewMs?: number;

	/**
	 * Debounce interval for account-related toasts.
	 * @default 60000
	 */
	rateLimitToastDebounceMs?: number;

	/**
	 * When all accounts are rate-limited, optionally wait and retry.
	 * @default false
	 */
	retryAllAccountsRateLimited?: boolean;

	/**
	 * Maximum time to wait when all accounts are rate-limited.
	 * Set to 0 to disable wait limit.
	 * @default 30000
	 */
	retryAllAccountsMaxWaitMs?: number;

	/**
	 * Maximum number of "all accounts rate-limited" waits.
	 * @default 1
	 */
	retryAllAccountsMaxRetries?: number;
}

export type AccountSelectionStrategy = "sticky" | "round-robin";

export type OAuthAuthDetails = Extract<Auth, { type: "oauth" }>;

export type CooldownReason = "auth-failure";

export type RateLimitStateV3 = Record<string, number | undefined>;

export interface AccountRecordV3 {
	refreshToken: string;
	accountId?: string;
	email?: string;
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
 * User configuration structure from opencode.json
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
 * Configuration options for reasoning and text settings
 */
export interface ConfigOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
}

/**
 * Reasoning configuration for requests
 */
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed" | "off" | "on";
}

/**
 * OAuth server information
 */
export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

/**
 * PKCE challenge and verifier
 */
export interface PKCEPair {
	challenge: string;
	verifier: string;
}

/**
 * Authorization flow result
 */
export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

/**
 * Token exchange success result
 */
export interface TokenSuccess {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
}

/**
 * Token exchange failure result
 */
export interface TokenFailure {
	type: "failed";
}

/**
 * Token exchange result
 */
export type TokenResult = TokenSuccess | TokenFailure;

/**
 * Parsed authorization input
 */
export interface ParsedAuthInput {
	code?: string;
	state?: string;
}

/**
 * JWT payload with ChatGPT account info
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
}

/**
 * Message input item
 */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Request body structure
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
 * SSE event data structure
 */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/**
 * Cache metadata for Codex instructions
 */
export interface CacheMetadata {
	etag: string | null;
	tag: string;
	lastChecked: number;
	url: string;
}

/**
 * GitHub release data
 */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

// Re-export SDK types for convenience
export type { Auth, Provider, Model };
