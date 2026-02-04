import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { FetchOrchestrator, FetchOrchestratorConfig } from '../lib/fetch-orchestrator.js';
import { AccountManager, formatAccountLabel } from '../lib/accounts.js';
import { RateLimitTracker } from '../lib/rate-limit.js';
import { CodexStatusManager } from '../lib/codex-status.js';
import { TokenBucketTracker, HealthScoreTracker } from '../lib/rotation.js';
import { PluginConfig } from '../lib/types.js';

describe('FetchOrchestrator', () => {
	let config: FetchOrchestratorConfig;
	let orchestrator: FetchOrchestrator;
	let accountManager: any;
	let rateLimitTracker: any;
	let healthTracker: any;
	let tokenTracker: any;
	let codexStatus: any;
	let pluginConfig: PluginConfig;

	const mockFetch = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetAllMocks();
        // ...
		global.fetch = mockFetch;

		accountManager = {
			getAccountCount: vi.fn(),
			getLegacyAccounts: vi.fn().mockReturnValue([]),
			repairLegacyAccounts: vi.fn(),
			getStorageSnapshot: vi.fn(),
			removeAccountsByRefreshToken: vi.fn(),
			getCurrentOrNextForFamily: vi.fn(),
			toAuthDetails: vi.fn(),
			refreshAccountWithFallback: vi.fn(),
			updateFromAuth: vi.fn(),
			saveToDisk: vi.fn(),
			markAccountCoolingDown: vi.fn(),
			markAccountUsed: vi.fn(),
			markRateLimited: vi.fn(),
			markSwitched: vi.fn(),
			shouldShowAccountToast: vi.fn(),
			markToastShown: vi.fn(),
			getMinWaitTimeForFamilyWithHydration: vi.fn().mockResolvedValue(0),
			getAccountsSnapshot: vi.fn().mockReturnValue([]),
			getActiveIndexForFamily: vi.fn(),
		};

		rateLimitTracker = {
			getBackoff: vi.fn(),
		};

		healthTracker = {
			recordSuccess: vi.fn(),
			recordFailure: vi.fn(),
			recordRateLimit: vi.fn(),
		};

		tokenTracker = {
			consume: vi.fn().mockReturnValue(true),
			refund: vi.fn(),
		};

		codexStatus = {
			updateFromHeaders: vi.fn().mockResolvedValue(undefined),
			updateFromSnapshot: vi.fn().mockResolvedValue(undefined),
			renderStatus: vi.fn().mockResolvedValue([]),
		};

		pluginConfig = {
			// Mock minimal config
			request: {
				scheduling: 'round-robin',
				account_selection: 'round-robin',
			}
		} as any;

		config = {
			accountManager: accountManager as AccountManager,
			pluginConfig,
			rateLimitTracker: rateLimitTracker as RateLimitTracker,
			healthTracker: healthTracker as HealthScoreTracker,
			tokenTracker: tokenTracker as TokenBucketTracker,
			codexStatus: codexStatus as CodexStatusManager,
			proactiveRefreshQueue: null,
			pidOffsetEnabled: false,
			tokenRefreshSkewMs: 60000,
			userConfig: { global: {}, models: {} },
			onAuthUpdate: vi.fn(),
			showToast: vi.fn(),
		};

		orchestrator = new FetchOrchestrator(config);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('should execute a successful request', async () => {
		accountManager.getAccountCount.mockReturnValue(1);
		accountManager.getCurrentOrNextForFamily.mockReturnValue({ index: 0, accountId: 'acc1', email: 'test@example.com' });
		accountManager.toAuthDetails.mockReturnValue({
			access: 'valid-token',
			expires: Date.now() + 100000,
		});

		mockFetch.mockImplementation(() => Promise.resolve(new Response('{"success":true}', {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		})));

		const response = await orchestrator.execute('https://api.openai.com/v1/chat/completions', { method: 'POST' });

		expect(response.status).toBe(200);
		expect(accountManager.getCurrentOrNextForFamily).toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalled();
		expect(accountManager.markAccountUsed).toHaveBeenCalledWith(0);
	});

	it('should handle 401 Unauthorized and recover', async () => {
		accountManager.getAccountCount.mockReturnValue(1);
		accountManager.getCurrentOrNextForFamily.mockReturnValue({ index: 0, accountId: 'acc1', email: 'test@example.com' });
		accountManager.toAuthDetails.mockReturnValue({
			access: 'expired-token',
			expires: Date.now() + 100000,
		});

		// First call fails with 401
		mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
		// Refresh succeeds
		accountManager.refreshAccountWithFallback.mockResolvedValue({
			type: 'success',
			access: 'new-token',
			refresh: 'new-refresh',
			expires: Date.now() + 3600000,
		});
		// Second call succeeds
		mockFetch.mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));

		const response = await orchestrator.execute('https://api.openai.com/v1/chat/completions', { method: 'POST' });

		expect(response.status).toBe(200);
		expect(accountManager.refreshAccountWithFallback).toHaveBeenCalled();
		expect(config.onAuthUpdate).toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('should handle rate limits and switch accounts', async () => {
		accountManager.getAccountCount.mockReturnValue(2);
		
		// First account
		accountManager.getCurrentOrNextForFamily
			.mockReturnValueOnce({ index: 0, accountId: 'acc1', email: 'acc1@example.com' })
			.mockReturnValueOnce({ index: 1, accountId: 'acc2', email: 'acc2@example.com' });

		accountManager.toAuthDetails.mockReturnValue({
			access: 'valid-token',
			expires: Date.now() + 100000,
		});

		// First account returns 429
		mockFetch.mockResolvedValueOnce(new Response('Rate limit', {
			status: 429,
			headers: { 'retry-after': '60' }
		}));

		rateLimitTracker.getBackoff.mockReturnValue({
			delayMs: 60000,
			attempt: 1,
			isDuplicate: false,
		});

		// Second account returns 200
		mockFetch.mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));

		// Configure config to switch on first rate limit (default logic mostly implies this or based on decision)
		// We mock decideRateLimitAction logic by controlling return value of rateLimitTracker and assuming default behavior
		// But decideRateLimitAction is imported from rate-limit.js, which is a real dependency.
		// We might need to mock decideRateLimitAction if we want to force "switch" vs "wait".
		// For now, let's assume the default config + multiple accounts = switch.

		const response = await orchestrator.execute('https://api.openai.com/v1/chat/completions', { method: 'POST' });

		expect(response.status).toBe(200);
		expect(accountManager.markRateLimited).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }), 60000, expect.any(String), undefined);
		expect(accountManager.markSwitched).toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('passes quiet mode to rate-limit toast', async () => {
		accountManager.getAccountCount.mockReturnValue(2);
		accountManager.shouldShowAccountToast.mockReturnValue(true);

		accountManager.getCurrentOrNextForFamily
			.mockReturnValueOnce({ index: 0, accountId: 'acc1', email: 'acc1@example.com' })
			.mockReturnValueOnce({ index: 1, accountId: 'acc2', email: 'acc2@example.com' });

		accountManager.toAuthDetails.mockReturnValue({
			access: 'valid-token',
			expires: Date.now() + 100000,
		});

		mockFetch.mockResolvedValueOnce(new Response('Rate limit', {
			status: 429,
			headers: { 'retry-after': '60' }
		}));

		rateLimitTracker.getBackoff.mockReturnValue({
			delayMs: 60000,
			attempt: 1,
			isDuplicate: false,
		});

		mockFetch.mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));

		config = { ...config, quietMode: true } as any;
		orchestrator = new FetchOrchestrator(config);

		await orchestrator.execute('https://api.openai.com/v1/chat/completions', { method: 'POST' });

		expect(config.showToast).toHaveBeenCalledWith('Rate limited - switching account', 'warning', true);
	});

	it('shows a toast when a new chat starts', async () => {
		accountManager.getAccountCount.mockReturnValue(1);
		const account = { index: 0, accountId: 'acc1', email: 'test@example.com', plan: 'Pro' };
		accountManager.getCurrentOrNextForFamily.mockReturnValue(account);
		accountManager.toAuthDetails.mockReturnValue({ access: 'token', expires: Date.now() + 100000 });
		mockFetch.mockImplementation(() => Promise.resolve(new Response('{"success":true}', {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})));

		await orchestrator.execute('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'gpt-5.1', prompt_cache_key: 'ses_new_1' }),
		});

		const label = formatAccountLabel(account, account.index);
		expect(config.showToast).toHaveBeenCalledWith(`New chat: ${label}`, 'info', false);
	});

	it('shows a toast when switching to an existing session', async () => {
		accountManager.getAccountCount.mockReturnValue(1);
		const account = { index: 0, accountId: 'acc1', email: 'test@example.com', plan: 'Pro' };
		accountManager.getCurrentOrNextForFamily.mockReturnValue(account);
		accountManager.toAuthDetails.mockReturnValue({ access: 'token', expires: Date.now() + 100000 });
		mockFetch.mockImplementation(() => Promise.resolve(new Response('{"success":true}', {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})));

		await orchestrator.execute('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'gpt-5.1', prompt_cache_key: 'ses_alpha' }),
		});
		await orchestrator.execute('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'gpt-5.1', prompt_cache_key: 'ses_beta' }),
		});
		await orchestrator.execute('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'gpt-5.1', prompt_cache_key: 'ses_alpha' }),
		});

		const label = formatAccountLabel(account, account.index);
		expect(config.showToast).toHaveBeenNthCalledWith(3, `Session switched: ${label}`, 'info', false);
	});

	it('shows a toast when the account changes', async () => {
		accountManager.getAccountCount.mockReturnValue(2);
		const first = { index: 0, accountId: 'acc1', email: 'one@example.com', plan: 'Pro' };
		const second = { index: 1, accountId: 'acc2', email: 'two@example.com', plan: 'Pro' };
		accountManager.getCurrentOrNextForFamily
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		accountManager.toAuthDetails.mockReturnValue({ access: 'token', expires: Date.now() + 100000 });
		mockFetch.mockImplementation(() => Promise.resolve(new Response('{"success":true}', {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})));

		await orchestrator.execute('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'gpt-5.1' }),
		});
		await orchestrator.execute('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'gpt-5.1' }),
		});

		const label = formatAccountLabel(second, second.index);
		expect(config.showToast).toHaveBeenCalledWith(`Account switched: ${label}`, 'info', false);
	});

	it('should return 429 if all accounts are exhausted', async () => {
		// Use 2 accounts to force "switch" action instead of "wait" (infinite loop for 1 account)
		accountManager.getAccountCount.mockReturnValue(2);
		accountManager.getCurrentOrNextForFamily
			.mockReturnValueOnce({ index: 0, accountId: 'acc1', email: 'acc1@example.com' })
			.mockReturnValueOnce({ index: 1, accountId: 'acc2', email: 'acc2@example.com' });

		accountManager.getAccountsSnapshot.mockReturnValue([
			{ index: 0, accountId: 'acc1', email: 'acc1@example.com', enabled: true },
			{ index: 1, accountId: 'acc2', email: 'acc2@example.com', enabled: true }
		]);
		accountManager.toAuthDetails.mockReturnValue({
			access: 'valid-token',
			expires: Date.now() + 100000,
		});

		mockFetch.mockImplementation(() => Promise.resolve(new Response('Rate limit', {
			status: 429,
			headers: { 'retry-after': '60' }
		})));
		
		rateLimitTracker.getBackoff.mockReturnValue({ delayMs: 60000, attempt: 1 });
		accountManager.getMinWaitTimeForFamilyWithHydration.mockResolvedValue(60000);

		const response = await orchestrator.execute('https://api.openai.com/v1/chat/completions', { method: 'POST' });

		expect(response.status).toBe(429);
		const body = await response.json();
		expect(body.error.message).toContain('All 2 account(s) unavailable');
	});

	it('should not loop infinitely on persistent 401', async () => {
		accountManager.getAccountCount.mockReturnValue(1);
		accountManager.getCurrentOrNextForFamily.mockReturnValue({ index: 0, accountId: 'acc1', email: 'test@example.com' });
		accountManager.toAuthDetails.mockReturnValue({ access: 'bad-token', expires: Date.now() + 100000 });

		// Use mockImplementation to return a NEW Response each time
		mockFetch.mockImplementation(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));
		// Refresh always succeeds
		accountManager.refreshAccountWithFallback.mockResolvedValue({
			type: 'success',
			access: 'new-token',
			refresh: 'new-refresh',
			expires: Date.now() + 3600000,
		});

		const response = await orchestrator.execute('https://api.openai.com/v1/chat/completions', { method: 'POST' });

		expect(response.status).toBe(429); // Fails after retry limit
		expect(mockFetch).toHaveBeenCalledTimes(2); // Initial + 1 retry
		expect(accountManager.markAccountCoolingDown).toHaveBeenCalled();
	});

	it('should handle non-JSON or non-string bodies gracefully', async () => {
		accountManager.getAccountCount.mockReturnValue(1);
		accountManager.getCurrentOrNextForFamily.mockReturnValue({ index: 0, accountId: 'acc1', email: 'test@example.com' });
		accountManager.toAuthDetails.mockReturnValue({ access: 'token', expires: Date.now() + 100000 });
		mockFetch.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));

		// Test with non-JSON string
		await expect(orchestrator.execute('https://api.openai.com/v1/chat/completions', { 
			method: 'POST', 
			body: 'not-json' 
		})).resolves.toBeDefined();

		// Test with non-string body
		await expect(orchestrator.execute('https://api.openai.com/v1/chat/completions', { 
			method: 'POST', 
			body: { some: 'object' } as any 
		})).resolves.toBeDefined();
	});
});
