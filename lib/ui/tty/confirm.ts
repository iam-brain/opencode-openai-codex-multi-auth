import { runSelect } from "./select.js";

export type ConfirmArgs = {
	title: string;
	message: string;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
	useColor?: boolean;
};

export async function runConfirm(args: ConfirmArgs): Promise<boolean | null> {
	const result = await runSelect({
		title: args.title,
		subtitle: args.message,
		items: [
			{ label: "Yes", value: true },
			{ label: "No", value: false },
		],
		input: args.input,
		output: args.output,
		initialIndex: 0,
		useColor: args.useColor,
	});

	if (!result) return null;
	return Boolean(result.value);
}
