import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { renderQuotaReport } from "../lib/ui/codex-quota-report.js";

const ANSI_REGEX = /\u001b\[[0-9;]*m/g;

describe("codex quota report", () => {
  it("renders account blocks with aligned percent", () => {
    const accountsFixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/openai-codex-accounts.json", import.meta.url),
        "utf-8",
      ),
    ) as {
      accounts: Array<{
        accountId: string;
        email: string;
        plan: string;
        refreshToken: string;
      }>;
    };
    const snapshotEntries = JSON.parse(
      readFileSync(
        new URL("./fixtures/codex-status-snapshots.json", import.meta.url),
        "utf-8",
      ),
    ) as Array<[string, any]>;
    const snapshots = snapshotEntries.map((entry) => entry[1]);
    const account = accountsFixture.accounts[0]!;
    const now = snapshots[0]?.updatedAt ?? Date.now();

    const output = renderQuotaReport([account], snapshots, now).join("\n");
    const plainOutput = output.replace(ANSI_REGEX, "");
    expect(plainOutput).toContain("Quota Report");
    expect(plainOutput).toContain(account.email);
    expect(plainOutput).toContain(`(${account.plan})`);
    expect(plainOutput).toContain("Codex CLI Quota");
    expect(plainOutput).toContain("5h");
    expect(plainOutput).toContain("Weekly");
    expect(plainOutput).toContain("┌");
    expect(plainOutput).toContain("│");

    // Percents aligned to 3 characters.
    expect(plainOutput).toMatch(/\s\d{1,3}%/);
    // Bars use block characters.
    expect(plainOutput).toMatch(/[█░]{20}/);
  });
});
