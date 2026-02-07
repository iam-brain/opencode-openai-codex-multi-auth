export type SelectKeyAction = "up" | "down" | "enter" | "cancel" | "unknown";

export type SelectItem<T = unknown> = {
	label: string;
	value?: T;
	hint?: string;
};

export type RenderSelectFrameArgs<T = unknown> = {
	title: string;
	subtitle?: string;
	items: Array<SelectItem<T>>;
	selectedIndex: number;
	useColor?: boolean;
};

export type RunSelectArgs<T = unknown> = {
	title: string;
	subtitle?: string;
	items: Array<SelectItem<T>>;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
	initialIndex?: number;
	useColor?: boolean;
};

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
};

function colorize(text: string, code: string, useColor?: boolean): string {
	return useColor ? `${code}${text}${ANSI.reset}` : text;
}

export function renderSelectFrame<T>(args: RenderSelectFrameArgs<T>): string[] {
	const lines: string[] = [];
	const top = colorize("+", ANSI.dim, args.useColor);
	const pipe = colorize("|", ANSI.dim, args.useColor);
	lines.push(`${top}  ${args.title}`);
	lines.push(pipe);
	if (args.subtitle) {
		lines.push(`${pipe}  ${args.subtitle}`);
	}
	if (args.items.length > 0) {
		lines.push(pipe);
	}

	args.items.forEach((item, index) => {
		const marker = index === args.selectedIndex ? colorize(">", ANSI.green, args.useColor) : " ";
		const hint = item.hint ? ` ${item.hint}` : "";
		lines.push(`${pipe}  ${marker} ${item.label}${hint}`);
	});

	lines.push(`${pipe}  ^/v to select, Enter: confirm`);
	lines.push(top);
	return lines;
}

export function parseSelectKey(input: string): SelectKeyAction {
	if (input === "\r" || input === "\n") return "enter";
	if (input === "\u001b") return "cancel";
	if (input === "\u0003") return "cancel";
	if (input === "\u001b[A" || input === "\u001bOA") return "up";
	if (input === "\u001b[B" || input === "\u001bOB") return "down";

	if (input === "k" || input === "K") return "up";
	if (input === "j" || input === "J") return "down";

	return "unknown";
}

export function moveSelectIndex(current: number, delta: number, size: number): number {
	if (size <= 0) return 0;
	const next = (current + delta) % size;
	return next < 0 ? next + size : next;
}

export async function runSelect<T>(args: RunSelectArgs<T>): Promise<SelectItem<T> | null> {
	const input = args.input ?? process.stdin;
	const output = args.output ?? process.stdout;
	if (!input.isTTY || !output.isTTY || args.items.length === 0) return null;

	let selectedIndex = Math.min(
		Math.max(args.initialIndex ?? 0, 0),
		Math.max(args.items.length - 1, 0),
	);
	let resolved = false;

	const render = () => {
		const lines = renderSelectFrame({
			title: args.title,
			subtitle: args.subtitle,
			items: args.items,
			selectedIndex,
			useColor: args.useColor,
		});
		output.write("\x1b[2J\x1b[H");
		output.write(lines.join("\n") + "\n");
	};

	const cleanup = () => {
		if (resolved) return;
		resolved = true;
		input.off("data", onData);
		input.pause();
		if (typeof input.setRawMode === "function") {
			input.setRawMode(false);
		}
	};

	const onData = (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const action = parseSelectKey(text);
		if (action === "up") {
			selectedIndex = moveSelectIndex(selectedIndex, -1, args.items.length);
			render();
			return;
		}
		if (action === "down") {
			selectedIndex = moveSelectIndex(selectedIndex, 1, args.items.length);
			render();
			return;
		}
		if (action === "enter") {
			const selected = args.items[selectedIndex] ?? null;
			cleanup();
			resolvePromise(selected);
			return;
		}
		if (action === "cancel") {
			cleanup();
			resolvePromise(null);
		}
	};

	let resolvePromise: (value: SelectItem<T> | null) => void = () => undefined;
	const promise = new Promise<SelectItem<T> | null>((resolve) => {
		resolvePromise = resolve;
	});

	if (typeof input.setRawMode === "function") {
		input.setRawMode(true);
	}
	input.resume();
	input.on("data", onData);
	input.setEncoding?.("utf8");
	output.write("\x1b[?25l");
	render();
	const result = await promise;
	output.write("\x1b[?25h");
	return result;
}
