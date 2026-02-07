import { PassThrough } from "node:stream";

import { describe, it, expect, vi } from "vitest";

import { runConfirm } from "../lib/ui/tty/confirm.js";

describe("tty confirm", () => {
	it("returns true when confirming", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		(input as unknown as { isTTY: boolean }).isTTY = true;
		(output as unknown as { isTTY: boolean }).isTTY = true;
		(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = vi.fn();

		const resultPromise = runConfirm({
			title: "Delete account",
			message: "Delete user?",
			input,
			output,
			useColor: false,
		});

		input.write("\r");
		const result = await resultPromise;
		expect(result).toBe(true);
	});
});
