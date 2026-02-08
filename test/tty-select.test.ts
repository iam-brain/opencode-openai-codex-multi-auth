import { PassThrough } from "node:stream";

import { describe, it, expect, vi } from "vitest";

import { ANSI } from "../lib/ui/tty/ansi.js";
import { select } from "../lib/ui/tty/select.js";

function makeTty(columns = 80) {
	const input = new PassThrough();
	const output = new PassThrough();
	(input as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { columns: number }).columns = columns;
	(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = vi.fn();
	return { input, output };
}

function captureOutput(output: PassThrough): { chunks: string[] } {
	const chunks: string[] = [];
	output.on("data", (chunk) => chunks.push(chunk.toString()));
	return { chunks };
}

describe("tty select", () => {
	it("renders box drawing without clearing the screen", async () => {
		const { input, output } = makeTty();
		const capture = captureOutput(output);
		const resultPromise = select(
			[
				{ label: "Add new account", value: "add" },
				{ label: "Check quotas", value: "check" },
			],
			{
				message: "Manage accounts",
				subtitle: "Select account",
				input: input as unknown as NodeJS.ReadStream,
				output: output as unknown as NodeJS.WriteStream,
			},
		);

		input.write("\r");
		await resultPromise;
		const text = capture.chunks.join("");

		expect(text).toContain("┌");
		expect(text).toContain("└");
		expect(text).toContain("│");
		expect(text).not.toContain(ANSI.clearScreen);
	});

	it("honors NO_COLOR for label styling", async () => {
		const originalNoColor = process.env.NO_COLOR;
		process.env.NO_COLOR = "1";
		try {
			const { input, output } = makeTty();
			const capture = captureOutput(output);
			const resultPromise = select(
				[
					{ label: "Add new account", value: "add" },
					{ label: "Check quotas", value: "check" },
				],
				{
					message: "Manage accounts",
					input: input as unknown as NodeJS.ReadStream,
					output: output as unknown as NodeJS.WriteStream,
				},
			);
			input.write("\r");
			await resultPromise;
			const text = capture.chunks.join("");

			expect(text).not.toContain(ANSI.green);
			expect(text).not.toContain(ANSI.yellow);
			expect(text).not.toContain(ANSI.red);
		} finally {
			if (originalNoColor === undefined) {
				delete process.env.NO_COLOR;
			} else {
				process.env.NO_COLOR = originalNoColor;
			}
		}
	});

	it("truncates long labels for narrow terminals", async () => {
		const { input, output } = makeTty(28);
		const capture = captureOutput(output);
		const resultPromise = select(
			[
				{ label: "ExtremelyLongAccountLabel", value: "one", hint: "used today" },
				{ label: "Short", value: "two" },
			],
			{
				message: "Manage accounts",
				input: input as unknown as NodeJS.ReadStream,
				output: output as unknown as NodeJS.WriteStream,
			},
		);

		input.write("\r");
		await resultPromise;
		const text = capture.chunks.join("");
		expect(text).toContain("ExtremelyLong");
		expect(text).toContain("…");
	});
});
