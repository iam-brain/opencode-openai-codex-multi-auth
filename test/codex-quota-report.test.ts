import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { renderQuotaReport } from "../lib/ui/codex-quota-report.js";

describe("codex quota report", () => {
	it("renders account blocks with aligned percent", () => {
		const accountsFixture = JSON.parse(
			readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
		) as { accounts: Array<{ accountId: string; email: string; plan: string; refreshToken: string }> };
		const snapshotEntries = JSON.parse(
			readFileSync(new URL("./fixtures/codex-status-snapshots.json", import.meta.url), "utf-8"),
		) as Array<[string, any]>;
		const snapshots = snapshotEntries.map((entry) => entry[1]);
		const account = accountsFixture.accounts[0]!;
		const now = snapshots[0]?.updatedAt ?? Date.now();

		const output = renderQuotaReport([account], snapshots, now).join("\n");
		expect(output).toContain("Checking quotas for all accounts...");
		expect(output).toContain(account.email);
		expect(output).toContain("Codex CLI Quota");
		expect(output).toContain("GPT-5");
		expect(output).toContain("Weekly");

		// Percents aligned to 3 characters.
		expect(output).toMatch(/\s\d{1,3}%/);
		// Bars use block characters.
		expect(output).toMatch(/[█░]{20}/);
	});
});
