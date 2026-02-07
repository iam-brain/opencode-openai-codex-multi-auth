import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("plugin config schema parity", () => {
	it("includes all runtime plugin config keys", () => {
		const schemaPath = join(
			process.cwd(),
			"assets",
			"openai-codex-auth-config.schema.json",
		);
		const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
			properties?: Record<string, unknown>;
		};
		const keys = new Set(Object.keys(schema.properties ?? {}));

		const expectedKeys = [
			"accountSelectionStrategy",
			"pidOffsetEnabled",
			"quietMode",
			"perProjectAccounts",
			"tokenRefreshSkewMs",
			"proactiveTokenRefresh",
			"authDebug",
			"rateLimitToastDebounceMs",
			"schedulingMode",
			"maxCacheFirstWaitSeconds",
			"switchOnFirstRateLimit",
			"rateLimitDedupWindowMs",
			"rateLimitStateResetMs",
			"defaultRetryAfterMs",
			"maxBackoffMs",
			"requestJitterMaxMs",
			"retryAllAccountsRateLimited",
			"retryAllAccountsMaxWaitMs",
			"retryAllAccountsMaxRetries",
		];

		for (const key of expectedKeys) {
			expect(keys.has(key), `schema missing "${key}"`).toBe(true);
		}
	});
});
