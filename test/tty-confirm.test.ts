import { PassThrough } from "node:stream";

import { describe, it, expect, vi } from "vitest";

import { confirm } from "../lib/ui/tty/confirm.js";

function makeTty() {
	const input = new PassThrough();
	const output = new PassThrough();
	(input as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { isTTY: boolean }).isTTY = true;
	(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = vi.fn();
	return { input, output };
}

describe("tty confirm", () => {
	it("returns true when confirming", async () => {
		const { input, output } = makeTty();
		const resultPromise = confirm("Delete account?", false, {
			input: input as unknown as NodeJS.ReadStream,
			output: output as unknown as NodeJS.WriteStream,
		});
		input.write("\u001b[B");
		input.write("\r");
		const result = await resultPromise;
		expect(result).toBe(true);
	});
});
