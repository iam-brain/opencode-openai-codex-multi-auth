import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { describe, it, expect, vi } from "vitest";

import { runAuthMenuOnce } from "../lib/ui/auth-menu-runner.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as { accounts: Array<{ accountId: string; email: string; plan: string; lastUsed: number }> };

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function makeTty() {
	const input = new PassThrough();
	const output = new PassThrough();
	(input as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { isTTY: boolean }).isTTY = true;
	(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = vi.fn();
	return { input, output };
}

describe("auth menu runner", () => {
	it("returns add when selecting add new account", async () => {
		const { input, output } = makeTty();
		const resultPromise = runAuthMenuOnce({
			accounts: [
				{
					index: 0,
					email: fixture.accounts[0]!.email,
					plan: fixture.accounts[0]!.plan,
					accountId: fixture.accounts[0]!.accountId,
					lastUsed: fixture.accounts[0]!.lastUsed,
				},
			],
			handlers: {
				onCheckQuotas: vi.fn(),
				onConfigureModels: vi.fn(),
				onDeleteAll: vi.fn(),
				onToggleAccount: vi.fn(),
				onRefreshAccount: vi.fn(),
				onDeleteAccount: vi.fn(),
			},
			input,
			output,
		});

		await tick();
		input.write("\r");

		const result = await resultPromise;
		expect(result).toBe("add");
	});

	it("invokes quota handler and continues", async () => {
		const { input, output } = makeTty();
		const onCheckQuotas = vi.fn();
		const resultPromise = runAuthMenuOnce({
			accounts: [
				{
					index: 0,
					email: fixture.accounts[0]!.email,
					plan: fixture.accounts[0]!.plan,
					accountId: fixture.accounts[0]!.accountId,
					lastUsed: fixture.accounts[0]!.lastUsed,
				},
			],
			handlers: {
				onCheckQuotas,
				onConfigureModels: vi.fn(),
				onDeleteAll: vi.fn(),
				onToggleAccount: vi.fn(),
				onRefreshAccount: vi.fn(),
				onDeleteAccount: vi.fn(),
			},
			input,
			output,
		});

		await tick();
		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result).toBe("continue");
		expect(onCheckQuotas).toHaveBeenCalledTimes(1);
	});

	it("routes account action to handler", async () => {
		const { input, output } = makeTty();
		const onToggleAccount = vi.fn();
		const resultPromise = runAuthMenuOnce({
			accounts: [
				{
					index: 0,
					email: fixture.accounts[0]!.email,
					plan: fixture.accounts[0]!.plan,
					accountId: fixture.accounts[0]!.accountId,
					lastUsed: fixture.accounts[0]!.lastUsed,
					enabled: true,
				},
			],
			handlers: {
				onCheckQuotas: vi.fn(),
				onConfigureModels: vi.fn(),
				onDeleteAll: vi.fn(),
				onToggleAccount,
				onRefreshAccount: vi.fn(),
				onDeleteAccount: vi.fn(),
			},
			input,
			output,
		});

		await tick();
		input.write("\u001b[B");
		input.write("\u001b[B");
		input.write("\r");

		await tick();
		input.write("\r");

		await tick();
		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result).toBe("continue");
		expect(onToggleAccount).toHaveBeenCalledTimes(1);
	});
});
