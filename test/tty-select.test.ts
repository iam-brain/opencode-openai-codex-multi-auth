import { describe, it, expect, vi } from "vitest";

import { PassThrough } from "node:stream";

import { renderSelectFrame, parseSelectKey, moveSelectIndex, runSelect } from "../lib/ui/tty/select.js";

describe("tty select", () => {
	it("renders ASCII frame and selection marker", () => {
		const lines = renderSelectFrame({
			title: "Manage accounts",
			subtitle: "Select account",
			items: [{ label: "Add new account" }, { label: "Check quotas", hint: "used today" }],
			selectedIndex: 0,
			useColor: false,
		});

		const output = lines.join("\n");
		expect(output).toContain("+  Manage accounts");
		expect(output).toContain("|  Select account");
		expect(output).toContain("|  > Add new account");
		expect(output).toContain("|    Check quotas used today");
		expect(output).toContain("^/v to select");
	});

	it("parses arrow and vim keys", () => {
		expect(parseSelectKey("\u001b[A")).toBe("up");
		expect(parseSelectKey("\u001b[B")).toBe("down");
		expect(parseSelectKey("k")).toBe("up");
		expect(parseSelectKey("j")).toBe("down");
		expect(parseSelectKey("\r")).toBe("enter");
		expect(parseSelectKey("\u001b")).toBe("cancel");
	});

	it("wraps selection index", () => {
		expect(moveSelectIndex(0, -1, 3)).toBe(2);
		expect(moveSelectIndex(2, 1, 3)).toBe(0);
		// No movement when list is empty.
		expect(moveSelectIndex(0, 1, 0)).toBe(0);
	});

	it("adds ANSI colors when enabled", () => {
		const lines = renderSelectFrame({
			title: "Manage accounts",
			items: [{ label: "Add new account" }],
			selectedIndex: 0,
			useColor: true,
		});
		expect(lines.join("\n")).toContain("\u001b[");
	});

	it("uses ASCII hint line", () => {
		const lines = renderSelectFrame({
			title: "Manage accounts",
			items: [{ label: "Add new account" }],
			selectedIndex: 0,
			useColor: false,
		});
		expect(lines.join("\n")).toContain("^/v to select, Enter: confirm");
	});

	it("selects item using key input", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		(input as unknown as { isTTY: boolean }).isTTY = true;
		(output as unknown as { isTTY: boolean }).isTTY = true;
		const setRawMode = vi.fn();
		(input as unknown as { setRawMode: (val: boolean) => void }).setRawMode = setRawMode;

		const resultPromise = runSelect({
			title: "Select",
			items: [
				{ label: "One", value: "one" },
				{ label: "Two", value: "two" },
			],
			input,
			output,
			useColor: false,
		});

		input.write("\u001b[B");
		input.write("\r");

		const result = await resultPromise;
		expect(result?.value).toBe("two");
		expect(setRawMode).toHaveBeenCalledWith(true);
		expect(setRawMode).toHaveBeenCalledWith(false);
	});
});
