import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	loadPluginConfig,
	getCodexMode,
	getPerProjectAccounts,
	getSchedulingMode,
	getMaxCacheFirstWaitSeconds,
	getAuthDebugEnabled,
	getNoBrowser,
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
		'CODEX_AUTH_MODE',
		'CODEX_AUTH_PER_PROJECT_ACCOUNTS',
		'CODEX_AUTH_SCHEDULING_MODE',
		'CODEX_AUTH_MAX_CACHE_FIRST_WAIT_SECONDS',
		'CODEX_AUTH_DEBUG',
		'OPENCODE_OPENAI_AUTH_DEBUG',
		'DEBUG_CODEX_PLUGIN',
		'CODEX_AUTH_NO_BROWSER',
		'OPENCODE_NO_BROWSER',
		'OPENCODE_HEADLESS',
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
			codexMode: false,
			accountSelectionStrategy: 'sticky',
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
			mockReadFileSync.mockReturnValue(JSON.stringify({ codexMode: true }));

			const config = loadPluginConfig();

			expect(config).toEqual({ ...expectedDefault, codexMode: true });
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
		it('should always return false by default', () => {
			expect(getCodexMode({})).toBe(false);
		});

		it('should ignore legacy env vars and config values', () => {
			process.env.CODEX_AUTH_MODE = '1';
			process.env.CODEX_MODE = '1';
			expect(getCodexMode({ codexMode: true })).toBe(false);
			expect(getCodexMode({ codexMode: false })).toBe(false);
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

	describe('getAuthDebugEnabled', () => {
		it('should return false by default', () => {
			delete process.env.CODEX_AUTH_DEBUG;
			delete process.env.OPENCODE_OPENAI_AUTH_DEBUG;
			delete process.env.DEBUG_CODEX_PLUGIN;
			expect(getAuthDebugEnabled()).toBe(false);
		});

		it('should check CODEX_AUTH_DEBUG first', () => {
			process.env.CODEX_AUTH_DEBUG = '1';
			process.env.OPENCODE_OPENAI_AUTH_DEBUG = '0';
			expect(getAuthDebugEnabled()).toBe(true);
		});

		it('should check OPENCODE_OPENAI_AUTH_DEBUG second', () => {
			delete process.env.CODEX_AUTH_DEBUG;
			process.env.OPENCODE_OPENAI_AUTH_DEBUG = '1';
			process.env.DEBUG_CODEX_PLUGIN = '0';
			expect(getAuthDebugEnabled()).toBe(true);
		});

		it('should check DEBUG_CODEX_PLUGIN third', () => {
			delete process.env.CODEX_AUTH_DEBUG;
			delete process.env.OPENCODE_OPENAI_AUTH_DEBUG;
			process.env.DEBUG_CODEX_PLUGIN = '1';
			expect(getAuthDebugEnabled()).toBe(true);
		});
	});

	describe('getNoBrowser', () => {
		it('should return false by default', () => {
			delete process.env.CODEX_AUTH_NO_BROWSER;
			delete process.env.OPENCODE_NO_BROWSER;
			delete process.env.OPENCODE_HEADLESS;
			expect(getNoBrowser()).toBe(false);
		});

		it('should check CODEX_AUTH_NO_BROWSER first', () => {
			process.env.CODEX_AUTH_NO_BROWSER = '1';
			process.env.OPENCODE_NO_BROWSER = '0';
			expect(getNoBrowser()).toBe(true);
		});

		it('should check OPENCODE_NO_BROWSER second', () => {
			delete process.env.CODEX_AUTH_NO_BROWSER;
			process.env.OPENCODE_NO_BROWSER = '1';
			process.env.OPENCODE_HEADLESS = '0';
			expect(getNoBrowser()).toBe(true);
		});

		it('should check OPENCODE_HEADLESS third', () => {
			delete process.env.CODEX_AUTH_NO_BROWSER;
			delete process.env.OPENCODE_NO_BROWSER;
			process.env.OPENCODE_HEADLESS = '1';
			expect(getNoBrowser()).toBe(true);
		});
	});

	describe('Priority order', () => {
		it('keeps codexMode as a legacy no-op', () => {
			process.env.CODEX_AUTH_MODE = '1';
			process.env.CODEX_MODE = '1';
			expect(getCodexMode({ codexMode: true })).toBe(false);
			expect(getCodexMode({ codexMode: false })).toBe(false);
			expect(getCodexMode({})).toBe(false);
		});
	});
});
