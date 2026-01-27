import { describe, it, expect } from "vitest";

import { extractAccountPlan, formatAccountLabel } from "../lib/accounts.js";

function makeJwt(payload: Record<string, unknown>): string {
	const header = { alg: "none", typ: "JWT" };
	const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signatureB64 = Buffer.from("sig").toString("base64url");
	return `${headerB64}.${payloadB64}.${signatureB64}`;
}

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
				{ email: "user@example.com", plan: "Pro", accountId: "acct-123456" },
				0,
			),
		).toBe("user@example.com (Pro)");
	});

	it("formatAccountLabel shows just email when plan missing", () => {
		expect(formatAccountLabel({ email: "user@example.com" }, 0)).toBe("user@example.com");
	});

	it("formatAccountLabel falls back to id suffix", () => {
		expect(formatAccountLabel({ accountId: "acct-123456" }, 0)).toBe("id:123456");
	});

	it("formatAccountLabel falls back to numbered account", () => {
		expect(formatAccountLabel(undefined, 0)).toBe("Account 1");
	});
});
