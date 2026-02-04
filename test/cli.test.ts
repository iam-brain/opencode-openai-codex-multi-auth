import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { readFileSync } from "node:fs";

const questionMock = vi.fn();
const closeMock = vi.fn();

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: questionMock,
		close: closeMock,
	})),
}));

import { promptLoginMode, promptManageAccounts } from "../lib/cli.js";

type AccountsFixture = {
	accounts: Array<{ accountId: string; email: string; plan: string }>;
};

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/openai-codex-accounts.json", import.meta.url), "utf-8"),
) as AccountsFixture;
const accountOne = fixture.accounts[0]!;
const accountTwo = fixture.accounts[1]!;

describe("cli", () => {
	beforeEach(() => {
		questionMock.mockReset();
		closeMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("promptLoginMode shows saved accounts and requires a/f", async () => {
		const logs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args.join(" "));
		});

		questionMock
			.mockResolvedValueOnce("x")
			.mockResolvedValueOnce("f");

		const mode = await promptLoginMode([
			{ index: 0, email: accountOne.email, plan: accountOne.plan, accountId: accountOne.accountId },
			{ index: 1, email: accountTwo.email, plan: accountTwo.plan, accountId: accountTwo.accountId },
		]);

		expect(mode).toBe("fresh");

		// Basic output shape
		expect(logs.join("\n")).toContain("2 account(s) saved:");
		expect(logs.join("\n")).toContain(`1. ${accountOne.email} (${accountOne.plan})`);
		expect(logs.join("\n")).toContain(`2. ${accountTwo.email} (${accountTwo.plan})`);

		// Prompts until valid input
		expect(questionMock).toHaveBeenCalledTimes(2);
		expect(closeMock).toHaveBeenCalledTimes(1);
		logSpy.mockRestore();
	});

	it("promptManageAccounts toggles by number", async () => {
		questionMock.mockResolvedValueOnce("1");

		const result = await promptManageAccounts([
			{ index: 0, email: accountOne.email, plan: accountOne.plan, accountId: accountOne.accountId },
			{ index: 1, email: accountTwo.email, plan: accountTwo.plan, accountId: accountTwo.accountId },
		]);

		expect(result).toEqual({ action: "toggle", index: 0 });
		expect(questionMock).toHaveBeenCalledTimes(1);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it("promptManageAccounts removes with r prefix", async () => {
		questionMock.mockResolvedValueOnce("r2");

		const result = await promptManageAccounts([
			{ index: 0, email: accountOne.email, plan: accountOne.plan, accountId: accountOne.accountId },
			{ index: 1, email: accountTwo.email, plan: accountTwo.plan, accountId: accountTwo.accountId },
		]);

		expect(result).toEqual({ action: "remove", index: 1 });
		expect(questionMock).toHaveBeenCalledTimes(1);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});
