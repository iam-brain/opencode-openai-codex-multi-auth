import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";

import {
	extractAccountPlan,
	formatAccountLabel,
	needsIdentityHydration,
} from "../lib/accounts.js";

function makeJwt(payload: Record<string, unknown>): string {
	const header = { alg: "none", typ: "JWT" };
	const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signatureB64 = Buffer.from("sig").toString("base64url");
	return `${headerB64}.${payloadB64}.${signatureB64}`;
}

type AccountsFixture = {
	accounts: Array<{ accountId: string; email: string; plan: string }>;
};

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as AccountsFixture;
const fixtureAccount = fixture.accounts[0]!;

describe("accounts", () => {
	it("extractAccountPlan reads ChatGPT plan type from JWT claim", () => {
		const token = makeJwt({
			"https://api.openai.com/auth": {
				chatgpt_plan_type: "pro",
			},
		});

		expect(extractAccountPlan(token)).toBe("Pro");
	});

	it("formatAccountLabel shows email and plan", () => {
		expect(
			formatAccountLabel(
				{
					email: fixtureAccount.email,
					plan: fixtureAccount.plan,
					accountId: fixtureAccount.accountId,
				},
				0,
			),
		).toBe(`${fixtureAccount.email} (${fixtureAccount.plan})`);
	});

	it("formatAccountLabel shows just email when plan missing", () => {
		expect(formatAccountLabel({ email: fixtureAccount.email }, 0)).toBe(fixtureAccount.email);
	});

	it("formatAccountLabel falls back to id suffix", () => {
		const suffix = fixtureAccount.accountId.slice(-6);
		expect(formatAccountLabel({ accountId: fixtureAccount.accountId }, 0)).toBe(`id:${suffix}`);
	});

	it("formatAccountLabel falls back to numbered account", () => {
		expect(formatAccountLabel(undefined, 0)).toBe("Account 1");
	});

	it("needsIdentityHydration ignores disabled accounts", () => {
		const accounts = [
			{ ...fixtureAccount, enabled: false, email: undefined },
		];
		expect(needsIdentityHydration(accounts)).toBe(false);
	});

	it("needsIdentityHydration returns true for enabled legacy accounts", () => {
		const accounts = [{ ...fixtureAccount, email: undefined }];
		expect(needsIdentityHydration(accounts)).toBe(true);
	});

	it("needsIdentityHydration returns false when all accounts complete", () => {
		const accounts = [{ ...fixtureAccount }];
		expect(needsIdentityHydration(accounts)).toBe(false);
	});
});
