import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TokenBucketTracker, selectHybridAccount, AccountWithMetrics } from "../lib/rotation.js";

// Load fixture accounts
const fixtureData = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures/openai-codex-accounts.json"), "utf8")
);
const fixtureAccounts = fixtureData.accounts;

describe("hybrid rotation", () => {
	it("prefers higher health score", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 70,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 90,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(1);
	});

	it("uses token bucket availability as secondary sort", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		tokenTracker.consume(accounts[1], 5);

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(0);
	});

	it("uses LRU (older lastUsed) as tertiary sort", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 1_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(1);
	});

	it("uses index as stable tie-breaker", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(0);
	});

	it("skips rate-limited accounts", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 90,
				isRateLimited: true,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(1);
	});

	it("skips accounts without token budget", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 90,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 80,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		tokenTracker.consume(accounts[0], 10);

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBe(1);
	});

	it("returns null when no account meets min health", () => {
		const tokenTracker = new TokenBucketTracker({
			maxTokens: 10,
			initialTokens: 10,
			regenerationRatePerMinute: 0,
		});
		const now = Date.now();

		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				accountId: fixtureAccounts[0].accountId,
				email: fixtureAccounts[0].email,
				plan: fixtureAccounts[0].plan,
				refreshToken: fixtureAccounts[0].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 40,
				isRateLimited: false,
				isCoolingDown: false,
			},
			{
				index: 1,
				accountId: fixtureAccounts[1].accountId,
				email: fixtureAccounts[1].email,
				plan: fixtureAccounts[1].plan,
				refreshToken: fixtureAccounts[1].refreshToken,
				lastUsed: now - 10_000,
				healthScore: 45,
				isRateLimited: false,
				isCoolingDown: false,
			},
		];

		const selected = selectHybridAccount(accounts, tokenTracker, 0, 50);
		expect(selected).toBeNull();
	});
});

describe("HealthScoreTracker state management", () => {
	it("accepts initial scores in constructor", async () => {
		const { HealthScoreTracker } = await import("../lib/rotation.js");
		const now = Date.now();
		const initialScores = {
			"key1": { score: 90, lastUpdated: now, consecutiveFailures: 0 }
		};
		const tracker = new HealthScoreTracker({}, initialScores);
		
		const scores = tracker.getScores();
		expect(scores).toEqual(initialScores);
	});

	it("getScores returns current state", async () => {
		const { HealthScoreTracker } = await import("../lib/rotation.js");
		const tracker = new HealthScoreTracker();
		const account = { accountId: "acc1", email: "test@example.com", plan: "plus" };
		
		tracker.recordSuccess(account);
		const scores = tracker.getScores();
		const key = Object.keys(scores)[0];
		
		expect(scores[key].score).toBeGreaterThan(70);
		expect(scores[key].consecutiveFailures).toBe(0);
	});
});

describe("TokenBucketTracker state management", () => {
	it("accepts initial buckets in constructor", async () => {
		const { TokenBucketTracker } = await import("../lib/rotation.js");
		const now = Date.now();
		const initialBuckets = {
			"key1": { tokens: 25, lastUpdated: now }
		};
		const tracker = new TokenBucketTracker({}, initialBuckets);
		const buckets = tracker.getBuckets();
		expect(buckets).toEqual(initialBuckets);
	});

	it("getBuckets returns current state", async () => {
		const { TokenBucketTracker } = await import("../lib/rotation.js");
		const tracker = new TokenBucketTracker({ maxTokens: 50, initialTokens: 50 });
		const account = { accountId: "acc1", email: "test@example.com", plan: "plus" };
		
		tracker.consume(account, 10);
		const buckets = tracker.getBuckets();
		const key = Object.keys(buckets)[0];
		
		expect(buckets[key].tokens).toBe(40);
	});
});
