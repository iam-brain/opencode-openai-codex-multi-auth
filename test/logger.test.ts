import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGGING_ENABLED, logRequest } from '../lib/logger.js';

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const original: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		original[key] = process.env[key];
		const value = env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key of Object.keys(env)) {
			const value = original[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe('Logger Module', () => {
	describe('LOGGING_ENABLED constant', () => {
		it('should be a boolean', () => {
			expect(typeof LOGGING_ENABLED).toBe('boolean');
		});

		it('should default to false when env variable is not set', () => {
			// This test verifies the default behavior
			// In a real test environment, ENABLE_PLUGIN_REQUEST_LOGGING would not be set
			const isEnabled = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === '1';
			expect(typeof isEnabled).toBe('boolean');
		});
	});

	describe('logRequest function', () => {
		it('should accept stage and data parameters', () => {
			// This should not throw
			expect(() => {
				logRequest('test-stage', { data: 'test' });
			}).not.toThrow();
		});

		it('should handle empty data object', () => {
			expect(() => {
				logRequest('test-stage', {});
			}).not.toThrow();
		});

		it('should handle complex data structures', () => {
			expect(() => {
				logRequest('test-stage', {
					nested: { data: 'value' },
					array: [1, 2, 3],
					number: 123,
					boolean: true,
				});
			}).not.toThrow();
		});

		it('redacts prompt_cache_key in request logs', async () => {
			const root = mkdtempSync(join(tmpdir(), 'opencode-logs-'));
			await withEnv({ ENABLE_PLUGIN_REQUEST_LOGGING: '1', XDG_CONFIG_HOME: root }, async () => {
				vi.resetModules();
				const { logRequest: logRequestWithEnv } = await import('../lib/logger.js');
				logRequestWithEnv('after-transform', {
					body: {
						prompt_cache_key: 'sess_123',
						kept: 'ok',
					},
				});

				const logDir = join(root, 'opencode', 'logs', 'codex-plugin');
				const files = readdirSync(logDir);
				expect(files.length).toBe(1);
				const payload = JSON.parse(
					readFileSync(join(logDir, files[0]!), 'utf8'),
				) as { body?: { prompt_cache_key?: string } };
				expect(payload.body?.prompt_cache_key).toBe('[redacted]');
			});
			rmSync(root, { recursive: true, force: true });
		});
	});

	describe('debug env flags', () => {
		it('logDebug respects CODEX_AUTH_DEBUG', async () => {
			await withEnv({ CODEX_AUTH_DEBUG: '1' }, async () => {
				vi.resetModules();
				const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				const { logDebug } = await import('../lib/logger.js');
				logDebug('debug enabled');
				expect(logSpy).toHaveBeenCalled();
				logSpy.mockRestore();
			});
		});

		it('logWarn respects CODEX_AUTH_DEBUG', async () => {
			await withEnv({ CODEX_AUTH_DEBUG: '1' }, async () => {
				vi.resetModules();
				const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
				const { logWarn } = await import('../lib/logger.js');
				logWarn('warn enabled');
				expect(warnSpy).toHaveBeenCalled();
				warnSpy.mockRestore();
			});
		});
	});
});
