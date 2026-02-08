import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { describe, it, expect, vi } from "vitest";

import { showAuthMenu, showAccountDetails } from "../lib/ui/auth-menu.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as { accounts: Array<{ accountId: string; email: string; plan: string; lastUsed: number }> };

function makeTty() {
	const input = new PassThrough();
	const output = new PassThrough();
	(input as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { isTTY: boolean }).isTTY = true;
	(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = vi.fn();
	return { input, output };
}

describe("auth menu flow", () => {
	it("selects a top-level action", async () => {
		const { input, output } = makeTty();
		const resultPromise = showAuthMenu(
			[
				{
					index: 0,
					email: fixture.accounts[0]!.email,
					lastUsed: fixture.accounts[0]!.lastUsed,
					enabled: true,
				},
			],
			{
				input: input as unknown as NodeJS.ReadStream,
				output: output as unknown as NodeJS.WriteStream,
			},
		);

		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result?.type).toBe("check");
	});

	it("selects an account action", async () => {
		const { input, output } = makeTty();
		const resultPromise = showAccountDetails(
			{
				index: 0,
				email: fixture.accounts[0]!.email,
				lastUsed: fixture.accounts[0]!.lastUsed,
				enabled: true,
				status: "active",
				isCurrentAccount: true,
			},
			{
				input: input as unknown as NodeJS.ReadStream,
				output: output as unknown as NodeJS.WriteStream,
			},
		);

		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result).toBe("toggle");
	});
});
