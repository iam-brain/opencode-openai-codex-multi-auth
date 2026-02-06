import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PluginConfig } from "./types.js";

const CONFIG_FILE = "openai-codex-auth-config.json";

function getOpencodeConfigDir(): string {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome && xdgConfigHome.trim()) {
		return join(xdgConfigHome, "opencode");
	}
	return join(homedir(), ".config", "opencode");
}

const CONFIG_PATH = join(getOpencodeConfigDir(), CONFIG_FILE);
const LEGACY_CONFIG_PATH = join(homedir(), ".opencode", CONFIG_FILE);

function migrateLegacyConfigIfNeeded(): void {
	if (existsSync(CONFIG_PATH)) return;
	if (!existsSync(LEGACY_CONFIG_PATH)) return;

	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		try {
			renameSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
			return;
		} catch {
			copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
			unlinkSync(LEGACY_CONFIG_PATH);
		}
	} catch {
		// Best-effort migration; ignore.
	}
}

/**
 * Default plugin configuration
 * Bridge mode is legacy and no longer affects runtime prompt behavior.
 */
const DEFAULT_CONFIG: PluginConfig = {
	codexMode: false,
	accountSelectionStrategy: "sticky",
	pidOffsetEnabled: true,
	quietMode: false,
	perProjectAccounts: false,
	retryAllAccountsRateLimited: false,
	retryAllAccountsMaxWaitMs: 30_000,
	retryAllAccountsMaxRetries: 1,
	tokenRefreshSkewMs: 60_000,
	proactiveTokenRefresh: false,
	authDebug: false,
	rateLimitToastDebounceMs: 60_000,
	schedulingMode: "cache_first",
	maxCacheFirstWaitSeconds: 60,
	switchOnFirstRateLimit: true,
	rateLimitDedupWindowMs: 2000,
	rateLimitStateResetMs: 120_000,
	defaultRetryAfterMs: 60_000,
	maxBackoffMs: 120_000,
	requestJitterMaxMs: 1000,
};

/**
 * Load plugin configuration from ~/.config/opencode/openai-codex-auth-config.json
 * Falls back to defaults if missing/invalid
 */
export function loadPluginConfig(): PluginConfig {
	try {
		migrateLegacyConfigIfNeeded();
		if (!existsSync(CONFIG_PATH)) {
			return DEFAULT_CONFIG;
		}

		const fileContent = readFileSync(CONFIG_PATH, "utf-8");
		const userConfig = JSON.parse(fileContent) as Partial<PluginConfig>;

		// Merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
		};
	} catch (error) {
		console.warn(
			`[openai-codex-plugin] Failed to load config from ${CONFIG_PATH}:`,
			(error as Error).message
		);
		return DEFAULT_CONFIG;
	}
}

function getEnvWithAlias(primary: string, ...aliases: string[]): string | undefined {
	if (process.env[primary]) return process.env[primary];
	for (const alias of aliases) {
		if (process.env[alias]) return process.env[alias];
	}
	return undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (value === "1" || value === "true") return true;
	if (value === "0" || value === "false") return false;
	return undefined;
}

function parseNumberEnv(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return undefined;
	return parsed;
}

function resolveBooleanSetting(
	envNames: string | string[],
	configValue: boolean | undefined,
	defaultValue: boolean,
): boolean {
	const names = Array.isArray(envNames) ? envNames : [envNames];
	const envValue = parseBooleanEnv(getEnvWithAlias(names[0], ...names.slice(1)));
	if (envValue !== undefined) return envValue;
	return configValue ?? defaultValue;
}

function resolveNumberSetting(
	envNames: string | string[],
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number },
): number {
	const names = Array.isArray(envNames) ? envNames : [envNames];
	const envValue = parseNumberEnv(getEnvWithAlias(names[0], ...names.slice(1)));
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min;
	if (min !== undefined) return Math.max(min, candidate);
	return candidate;
}

/**
 * Legacy no-op: bridge mode has been removed.
 */
export function getCodexMode(_pluginConfig: PluginConfig): boolean {
	return false;
}

export function getPerProjectAccounts(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PER_PROJECT_ACCOUNTS",
		pluginConfig.perProjectAccounts,
		false,
	);
}

export function getAccountSelectionStrategy(pluginConfig: PluginConfig):
	| "sticky"
	| "round-robin"
	| "hybrid" {
	const env = process.env.CODEX_AUTH_ACCOUNT_SELECTION_STRATEGY;
	if (env === "sticky" || env === "round-robin" || env === "hybrid") return env;
	return pluginConfig.accountSelectionStrategy ?? "sticky";
}

export function getPidOffsetEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PID_OFFSET_ENABLED",
		pluginConfig.pidOffsetEnabled,
		true,
	);
}

export function getQuietMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_AUTH_QUIET", pluginConfig.quietMode, false);
}

export function getTokenRefreshSkewMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		pluginConfig.tokenRefreshSkewMs,
		60_000,
		{ min: 0 },
	);
}

export function getRateLimitToastDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		pluginConfig.rateLimitToastDebounceMs,
		60_000,
		{ min: 0 },
	);
}

export function getRetryAllAccountsRateLimited(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		pluginConfig.retryAllAccountsRateLimited,
		false,
	);
}

export function getRetryAllAccountsMaxWaitMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		pluginConfig.retryAllAccountsMaxWaitMs,
		30_000,
		{ min: 0 },
	);
}

export function getRetryAllAccountsMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		pluginConfig.retryAllAccountsMaxRetries,
		1,
		{ min: 0 },
	);
}

export function getSchedulingMode(pluginConfig: PluginConfig):
	| "cache_first"
	| "balance"
	| "performance_first" {
	const env = process.env.CODEX_AUTH_SCHEDULING_MODE;
	if (env === "cache_first" || env === "balance" || env === "performance_first") return env;
	return pluginConfig.schedulingMode ?? "cache_first";
}

export function getMaxCacheFirstWaitSeconds(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_MAX_CACHE_FIRST_WAIT_SECONDS",
		pluginConfig.maxCacheFirstWaitSeconds,
		60,
		{ min: 0 },
	);
}

export function getSwitchOnFirstRateLimit(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SWITCH_ON_FIRST_RATE_LIMIT",
		pluginConfig.switchOnFirstRateLimit,
		true,
	);
}

export function getRateLimitDedupWindowMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RATE_LIMIT_DEDUP_WINDOW_MS",
		pluginConfig.rateLimitDedupWindowMs,
		2000,
		{ min: 0 },
	);
}

export function getRateLimitStateResetMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RATE_LIMIT_STATE_RESET_MS",
		pluginConfig.rateLimitStateResetMs,
		120_000,
		{ min: 0 },
	);
}

export function getDefaultRetryAfterMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_DEFAULT_RETRY_AFTER_MS",
		pluginConfig.defaultRetryAfterMs,
		60_000,
		{ min: 0 },
	);
}

export function getMaxBackoffMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_MAX_BACKOFF_MS",
		pluginConfig.maxBackoffMs,
		120_000,
		{ min: 0 },
	);
}

export function getRequestJitterMaxMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_REQUEST_JITTER_MAX_MS",
		pluginConfig.requestJitterMaxMs,
		1000,
		{ min: 0 },
	);
}

export function getProactiveTokenRefresh(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PROACTIVE_TOKEN_REFRESH",
		pluginConfig.proactiveTokenRefresh,
		false,
	);
}

export function getAuthDebugEnabled(pluginConfig?: PluginConfig): boolean {
	const config = pluginConfig ?? loadPluginConfig();
	return resolveBooleanSetting(
		["CODEX_AUTH_DEBUG", "OPENCODE_OPENAI_AUTH_DEBUG", "DEBUG_CODEX_PLUGIN"],
		config.authDebug,
		false,
	);
}

export function getNoBrowser(): boolean {
	return (
		parseBooleanEnv(
			getEnvWithAlias(
				"CODEX_AUTH_NO_BROWSER",
				"OPENCODE_NO_BROWSER",
				"OPENCODE_HEADLESS",
			),
		) ?? false
	);
}
