import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const questionMock = vi.fn();
const closeMock = vi.fn();

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: questionMock,
		close: closeMock,
	})),
}));

import { promptLoginMode } from "../lib/cli.js";

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
			{ index: 0, email: "user@example.com", plan: "Pro", accountId: "acct-123456" },
			{ index: 1, accountId: "acct-abcdef" },
		]);

		expect(mode).toBe("fresh");

		// Basic output shape
		expect(logs.join("\n")).toContain("2 account(s) saved:");
		expect(logs.join("\n")).toContain("1. user@example.com (Pro)");
		expect(logs.join("\n")).toContain("2. id:abcdef");

		// Prompts until valid input
		expect(questionMock).toHaveBeenCalledTimes(2);
		expect(closeMock).toHaveBeenCalledTimes(1);
		logSpy.mockRestore();
	});
});
