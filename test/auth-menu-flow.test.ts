import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { describe, it, expect, vi } from "vitest";

import {
	chooseAuthMenuAction,
	chooseAccountAction,
	chooseAccountFromList,
} from "../lib/ui/auth-menu-flow.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as { accounts: Array<{ accountId: string; email: string; plan: string; lastUsed: number }> };

describe("auth menu flow", () => {
	function makeTty() {
		const input = new PassThrough();
		const output = new PassThrough();
		(input as unknown as { isTTY: boolean }).isTTY = true;
		(output as unknown as { isTTY: boolean }).isTTY = true;
		(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = vi.fn();
		return { input, output };
	}

	it("selects a top-level action", async () => {
		const { input, output } = makeTty();
		const resultPromise = chooseAuthMenuAction({
			accounts: [
				{
					index: 0,
					email: fixture.accounts[0]!.email,
					plan: fixture.accounts[0]!.plan,
					accountId: fixture.accounts[0]!.accountId,
					lastUsed: fixture.accounts[0]!.lastUsed,
				},
			],
			input,
			output,
		});

		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result?.type).toBe("check-quotas");
	});

	it("selects an account action", async () => {
		const { input, output } = makeTty();
		const resultPromise = chooseAccountAction({
			account: {
				index: 0,
				email: fixture.accounts[0]!.email,
				plan: fixture.accounts[0]!.plan,
				enabled: true,
			},
			input,
			output,
		});

		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result).toBe("toggle");
	});

	it("selects an account from list", async () => {
		const { input, output } = makeTty();
		const resultPromise = chooseAccountFromList({
			accounts: [
				{
					index: 0,
					email: fixture.accounts[0]!.email,
					plan: fixture.accounts[0]!.plan,
					accountId: fixture.accounts[0]!.accountId,
					lastUsed: fixture.accounts[0]!.lastUsed,
				},
			],
			input,
			output,
		});

		input.write("\r");
		const result = await resultPromise;
		expect(result?.email).toBe(fixture.accounts[0]!.email);
	});
});
