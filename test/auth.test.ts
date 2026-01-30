import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
	createState,
	parseAuthorizationInput,
	decodeJWT,
	createAuthorizationFlow,
	CLIENT_ID,
	AUTHORIZE_URL,
	REDIRECT_URI,
	SCOPE,
} from '../lib/auth/auth.js';
import { ProactiveRefreshQueue, createRefreshScheduler } from '../lib/refresh-queue.js';
import { createJwt } from './helpers/jwt.js';

type CallbackFixture = {
	callbacks: Array<{
		url: string;
		expected: { code: string; state?: string };
		account: {
			refreshToken: string;
			accountId: string;
			email: string;
			plan: string;
		};
	}>;
};

type AccountsFixture = {
	accounts: Array<{
		refreshToken: string;
		accountId: string;
		email: string;
		plan: string;
	}>;
};

type HydrationFixture = {
	tokens: Array<{
		refreshToken: string;
		accessPayload: Record<string, unknown>;
		idPayload: Record<string, unknown>;
	}>;
};

function loadFixture<T>(fileName: string): T {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), 'utf-8'),
	) as T;
}

describe('Auth Module', () => {
	describe('createState', () => {
		it('should generate a random 32-character hex string', () => {
			const state = createState();
			expect(state).toMatch(/^[a-f0-9]{32}$/);
		});

		it('should generate unique states', () => {
			const state1 = createState();
			const state2 = createState();
			expect(state1).not.toBe(state2);
		});
	});

	describe('parseAuthorizationInput', () => {
		it('should parse full OAuth callback URL', () => {
			const input = 'http://localhost:1455/auth/callback?code=abc123&state=xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should parse fixture callback URLs', () => {
			const callbacks = loadFixture<CallbackFixture>('oauth-callbacks.json');
			const accounts = loadFixture<AccountsFixture>('openai-codex-accounts.json');

			for (const entry of callbacks.callbacks) {
				const parsed = parseAuthorizationInput(entry.url);
				expect(parsed).toEqual(entry.expected);
				const matchesAccount = accounts.accounts.some(
					(account) =>
						account.refreshToken === entry.account.refreshToken &&
						account.accountId === entry.account.accountId &&
						account.email === entry.account.email &&
						account.plan === entry.account.plan,
				);
				expect(matchesAccount).toBe(true);
			}
		});

		it('should parse code#state format', () => {
			const input = 'abc123#xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should parse query string format', () => {
			const input = 'code=abc123&state=xyz789';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
		});

		it('should parse code only', () => {
			const input = 'abc123';
			const result = parseAuthorizationInput(input);
			expect(result).toEqual({ code: 'abc123' });
		});

		it('should return empty object for empty input', () => {
			const result = parseAuthorizationInput('');
			expect(result).toEqual({});
		});

		it('should handle whitespace', () => {
			const result = parseAuthorizationInput('  ');
			expect(result).toEqual({});
		});
	});

	describe('fixture alignment', () => {
		it('should align hydration entries to base accounts', () => {
			const accounts = loadFixture<AccountsFixture>('openai-codex-accounts.json');
			const hydration = loadFixture<HydrationFixture>('oauth-hydration.json');

			const accountTokens = accounts.accounts.map((account) => account.refreshToken).sort();
			const hydrationTokens = hydration.tokens.map((token) => token.refreshToken).sort();

			expect(hydrationTokens).toEqual(accountTokens);
		});
	});

	describe('decodeJWT', () => {
		it('should decode valid JWT token', () => {
			const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
			const payloadObject = { v: '">' };
			const payload = Buffer.from(JSON.stringify(payloadObject)).toString('base64url');
			const signature = 'fake-signature';
			const token = `${header}.${payload}.${signature}`;

			expect(payload).toMatch(/[-_]/);

			const decoded = decodeJWT(token);
			expect(decoded).toEqual(payloadObject);
		});

		it('should reject non-url-safe base64 payloads', () => {
			const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
			const payload = Buffer.from(JSON.stringify({ v: '">' })).toString('base64');
			const signature = 'fake-signature';
			const token = `${header}.${payload}.${signature}`;

			expect(payload).toMatch(/[+/]/);

			const decoded = decodeJWT(token);
			expect(decoded).toBeNull();
		});

		it('should decode JWT with ChatGPT account info', () => {
			const hydration = loadFixture<HydrationFixture>('oauth-hydration.json');
			const accessPayload = hydration.tokens[0]!.accessPayload;
			const token = createJwt(accessPayload);
			const accountId =
				(accessPayload['https://api.openai.com/auth'] as { chatgpt_account_id?: string })
					?.chatgpt_account_id ?? null;

			const decoded = decodeJWT(token);
			expect(decoded?.['https://api.openai.com/auth']?.chatgpt_account_id).toBe(accountId);
		});

		it('should return null for invalid JWT', () => {
			const result = decodeJWT('invalid-token');
			expect(result).toBeNull();
		});

		it('should return null for malformed JWT', () => {
			const result = decodeJWT('header.payload');
			expect(result).toBeNull();
		});

		it('should return null for non-JSON payload', () => {
			const token = 'header.not-json.signature';
			const result = decodeJWT(token);
			expect(result).toBeNull();
		});
	});

	describe('createAuthorizationFlow', () => {
		it('should create authorization flow with PKCE', async () => {
			const flow = await createAuthorizationFlow();

			expect(flow).toHaveProperty('pkce');
			expect(flow).toHaveProperty('state');
			expect(flow).toHaveProperty('url');

			expect(flow.pkce).toHaveProperty('challenge');
			expect(flow.pkce).toHaveProperty('verifier');
			expect(flow.state).toMatch(/^[a-f0-9]{32}$/);
		});

		it('should generate URL with correct parameters', async () => {
			const flow = await createAuthorizationFlow();
			const url = new URL(flow.url);

			expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
			expect(url.searchParams.get('response_type')).toBe('code');
			expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
			expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
			expect(url.searchParams.get('scope')).toBe(SCOPE);
			expect(url.searchParams.get('code_challenge_method')).toBe('S256');
			expect(url.searchParams.get('code_challenge')).toBe(flow.pkce.challenge);
			expect(url.searchParams.get('state')).toBe(flow.state);
			expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
			expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
			expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
		});

		it('should generate unique flows', async () => {
			const flow1 = await createAuthorizationFlow();
			const flow2 = await createAuthorizationFlow();

			expect(flow1.state).not.toBe(flow2.state);
			expect(flow1.pkce.verifier).not.toBe(flow2.pkce.verifier);
			expect(flow1.url).not.toBe(flow2.url);
		});
	});

	describe('refresh queue', () => {
		it('refresh queue skips expired tokens', async () => {
			const now = 1_000_000;
			const refreshFn = vi.fn(async () => ({
				type: 'success' as const,
				access: 'access',
				refresh: 'refresh',
				expires: now + 60_000,
			}));
			const queue = new ProactiveRefreshQueue({
				bufferMs: 60_000,
				intervalMs: 0,
				now: () => now,
			});

			const result = await queue.enqueue({
				key: 'account-1',
				expires: now - 1_000,
				refresh: () => refreshFn(),
			});

			expect(result.type).toBe('skipped');
			expect(refreshFn).not.toHaveBeenCalled();
		});

		it('refresh queue serializes refresh calls', async () => {
			const now = 1_000_000;
			let active = 0;
			let maxActive = 0;
			const refreshFn = vi.fn(async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return {
					type: 'success' as const,
					access: 'access',
					refresh: 'refresh',
					expires: now + 60_000,
				};
			});
			const queue = new ProactiveRefreshQueue({
				bufferMs: 60_000,
				intervalMs: 0,
				now: () => now,
			});

			const [first, second] = await Promise.all([
				queue.enqueue({
					key: 'account-1',
					expires: now + 1_000,
					refresh: () => refreshFn(),
				}),
				queue.enqueue({
					key: 'account-2',
					expires: now + 1_000,
					refresh: () => refreshFn(),
				}),
			]);

			expect(refreshFn).toHaveBeenCalledTimes(2);
			expect(maxActive).toBe(1);
			expect(first.type).toBe('success');
			expect(second.type).toBe('success');
		});

		it('refresh scheduler enqueues tasks on interval', async () => {
			vi.useFakeTimers();
			try {
				const now = 1_000_000;
				const queue = new ProactiveRefreshQueue({
					bufferMs: 60_000,
					intervalMs: 0,
					now: () => now,
				});
				const refreshFn = vi.fn(async () => ({
					type: 'success' as const,
					access: 'access',
					refresh: 'refresh',
					expires: now + 60_000,
				}));
				const getTasks = vi.fn(() => [
					{
						key: 'account-1',
						expires: now + 30_000,
						refresh: () => refreshFn(),
					},
				]);
				const enqueueSpy = vi.spyOn(queue, 'enqueue');
				const scheduler = createRefreshScheduler({
					intervalMs: 1000,
					queue,
					getTasks,
				});

				scheduler.start();
				expect(enqueueSpy).toHaveBeenCalledTimes(1);
				expect(getTasks).toHaveBeenCalledTimes(1);

				vi.advanceTimersByTime(1000);
				expect(enqueueSpy).toHaveBeenCalledTimes(2);
				expect(getTasks).toHaveBeenCalledTimes(2);

				scheduler.stop();
				vi.advanceTimersByTime(2000);
				expect(enqueueSpy).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
