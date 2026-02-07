import type { AuthMenuAction, AuthMenuAccount, AccountAction } from "./auth-menu.js";
import { buildAccountActionItems, buildAuthMenuItems, buildAccountSelectItems } from "./auth-menu.js";
import { runSelect } from "./tty/select.js";

type SelectContext = {
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
};

export async function chooseAuthMenuAction(
	args: SelectContext & {
		accounts: AuthMenuAccount[];
		now?: number;
	},
): Promise<AuthMenuAction | null> {
	const items = buildAuthMenuItems(args.accounts, args.now);
	const selected = await runSelect({
		title: "Manage accounts",
		subtitle: "Select account",
		items,
		input: args.input,
		output: args.output,
		useColor: false,
	});
	return selected?.value ?? null;
}

export async function chooseAccountAction(
	args: SelectContext & {
		account: AuthMenuAccount;
	},
): Promise<AccountAction | null> {
	const items = buildAccountActionItems(args.account);
	const selected = await runSelect({
		title: "Account options",
		subtitle: "Select action",
		items,
		input: args.input,
		output: args.output,
		useColor: false,
	});
	return selected?.value ?? null;
}

export async function chooseAccountFromList(
	args: SelectContext & {
		accounts: AuthMenuAccount[];
		now?: number;
	},
): Promise<AuthMenuAccount | null> {
	const items = buildAccountSelectItems(args.accounts, args.now);
	const selected = await runSelect({
		title: "Manage accounts",
		subtitle: "Select account",
		items,
		input: args.input,
		output: args.output,
		useColor: false,
	});
	return selected?.value ?? null;
}
