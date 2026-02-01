import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	loadPluginConfig,
	getCodexMode,
	getPerProjectAccounts,
	getSchedulingMode,
	getMaxCacheFirstWaitSeconds,
} from '../lib/config.js';
import type { PluginConfig } from '../lib/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the fs module
vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

describe('Plugin Configuration', () => {
	const mockExistsSync = vi.mocked(fs.existsSync);
	const mockReadFileSync = vi.mocked(fs.readFileSync);
	const trackedEnvVars = [
		'CODEX_MODE',
		'CODEX_AUTH_PER_PROJECT_ACCOUNTS',
		'CODEX_AUTH_SCHEDULING_MODE',
		'CODEX_AUTH_MAX_CACHE_FIRST_WAIT_SECONDS',
	] as const;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		originalEnv = Object.fromEntries(
			trackedEnvVars.map((name) => [name, process.env[name]]),
		) as Record<string, string | undefined>;
		vi.clearAllMocks();
	});

	afterEach(() => {
		for (const name of trackedEnvVars) {
			const value = originalEnv[name];
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	});

	describe('loadPluginConfig', () => {
		const expectedDefault = {
			codexMode: true,
			accountSelectionStrategy: 'sticky',
			pidOffsetEnabled: true,
			quietMode: false,
			perProjectAccounts: false,
			retryAllAccountsRateLimited: false,
			retryAllAccountsMaxWaitMs: 30_000,
			retryAllAccountsMaxRetries: 1,
			tokenRefreshSkewMs: 60_000,
			proactiveTokenRefresh: false,
			rateLimitToastDebounceMs: 60_000,
			schedulingMode: 'cache_first',
			maxCacheFirstWaitSeconds: 60,
			switchOnFirstRateLimit: true,
			rateLimitDedupWindowMs: 2000,
			rateLimitStateResetMs: 120_000,
			defaultRetryAfterMs: 60_000,
			maxBackoffMs: 120_000,
			requestJitterMaxMs: 1000,
		};

		it('should return default config when file does not exist', () => {
			mockExistsSync.mockReturnValue(false);

			const config = loadPluginConfig();

			expect(config).toEqual(expectedDefault);
			expect(mockExistsSync).toHaveBeenCalledWith(
				path.join(os.homedir(), '.config', 'opencode', 'openai-codex-auth-config.json')
			);
		});

		it('should load config from file when it exists', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({ codexMode: false }));

			const config = loadPluginConfig();

			expect(config).toEqual({ ...expectedDefault, codexMode: false });
		});

		it('should merge user config with defaults', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(JSON.stringify({}));

			const config = loadPluginConfig();

			expect(config).toEqual(expectedDefault);
		});

		it('should handle invalid JSON gracefully', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue('invalid json');

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const config = loadPluginConfig();

			expect(config).toEqual(expectedDefault);
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('should handle file read errors gracefully', () => {
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation(() => {
				throw new Error('Permission denied');
			});

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const config = loadPluginConfig();

			expect(config).toEqual(expectedDefault);
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	describe('getPerProjectAccounts', () => {
		it('should default to false', () => {
			delete process.env.CODEX_AUTH_PER_PROJECT_ACCOUNTS;
			const config: PluginConfig = {};

			const result = getPerProjectAccounts(config);

			expect(result).toBe(false);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_AUTH_PER_PROJECT_ACCOUNTS;
			const config: PluginConfig = { perProjectAccounts: true };

			const result = getPerProjectAccounts(config);

			expect(result).toBe(true);
		});

		it('should prioritize env var CODEX_AUTH_PER_PROJECT_ACCOUNTS=1 over config', () => {
			process.env.CODEX_AUTH_PER_PROJECT_ACCOUNTS = '1';
			const config: PluginConfig = { perProjectAccounts: false };

			const result = getPerProjectAccounts(config);

			expect(result).toBe(true);
		});
	});

	describe('getCodexMode', () => {
		it('should return true by default', () => {
			delete process.env.CODEX_MODE;
			const config: PluginConfig = {};

			const result = getCodexMode(config);

			expect(result).toBe(true);
		});

		it('should use config value when env var not set', () => {
			delete process.env.CODEX_MODE;
			const config: PluginConfig = { codexMode: false };

			const result = getCodexMode(config);

			expect(result).toBe(false);
		});

		it('should prioritize env var CODEX_MODE=1 over config', () => {
			process.env.CODEX_MODE = '1';
			const config: PluginConfig = { codexMode: false };

			const result = getCodexMode(config);

			expect(result).toBe(true);
		});

		it('should prioritize env var CODEX_MODE=0 over config', () => {
			process.env.CODEX_MODE = '0';
			const config: PluginConfig = { codexMode: true };

			const result = getCodexMode(config);

			expect(result).toBe(false);
		});

		it('should handle env var with any value other than "1" as false', () => {
			process.env.CODEX_MODE = 'false';
			const config: PluginConfig = { codexMode: true };

			const result = getCodexMode(config);

			expect(result).toBe(false);
		});

		it('should use config codexMode=true when explicitly set', () => {
			delete process.env.CODEX_MODE;
			const config: PluginConfig = { codexMode: true };

			const result = getCodexMode(config);

			expect(result).toBe(true);
		});
	});

	describe('getSchedulingMode', () => {
		it('should prioritize env var when valid', () => {
			process.env.CODEX_AUTH_SCHEDULING_MODE = 'balance';
			const config: PluginConfig = { schedulingMode: 'cache_first' };

			const result = getSchedulingMode(config);

			expect(result).toBe('balance');
		});

		it('should fall back to config when env var invalid', () => {
			process.env.CODEX_AUTH_SCHEDULING_MODE = 'invalid';
			const config: PluginConfig = { schedulingMode: 'performance_first' };

			const result = getSchedulingMode(config);

			expect(result).toBe('performance_first');
		});

		it('should default to cache_first when unset', () => {
			delete process.env.CODEX_AUTH_SCHEDULING_MODE;
			const config: PluginConfig = {};

			const result = getSchedulingMode(config);

			expect(result).toBe('cache_first');
		});
	});

	describe('getMaxCacheFirstWaitSeconds', () => {
		it('should clamp negative env value to zero', () => {
			process.env.CODEX_AUTH_MAX_CACHE_FIRST_WAIT_SECONDS = '-5';

			const result = getMaxCacheFirstWaitSeconds({});

			expect(result).toBe(0);
		});

		it('should clamp negative config value to zero', () => {
			delete process.env.CODEX_AUTH_MAX_CACHE_FIRST_WAIT_SECONDS;
			const config: PluginConfig = { maxCacheFirstWaitSeconds: -1 };

			const result = getMaxCacheFirstWaitSeconds(config);

			expect(result).toBe(0);
		});

		it('should allow env override of config', () => {
			process.env.CODEX_AUTH_MAX_CACHE_FIRST_WAIT_SECONDS = '30';
			const config: PluginConfig = { maxCacheFirstWaitSeconds: 10 };

			const result = getMaxCacheFirstWaitSeconds(config);

			expect(result).toBe(30);
		});
	});

	describe('Priority order', () => {
		it('should follow priority: env var > config file > default', () => {
			// Test 1: env var overrides config
			process.env.CODEX_MODE = '0';
			expect(getCodexMode({ codexMode: true })).toBe(false);

			// Test 2: config overrides default
			delete process.env.CODEX_MODE;
			expect(getCodexMode({ codexMode: false })).toBe(false);

			// Test 3: default when neither set
			expect(getCodexMode({})).toBe(true);
		});
	});
});
