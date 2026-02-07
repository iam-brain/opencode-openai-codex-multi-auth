import type { AuthMenuAccount } from "./auth-menu.js";
import { chooseAccountAction, chooseAccountFromList, chooseAuthMenuAction } from "./auth-menu-flow.js";
import { runConfirm } from "./tty/confirm.js";

export type AuthMenuHandlers = {
	onCheckQuotas: () => Promise<void>;
	onConfigureModels: () => Promise<void>;
	onDeleteAll: () => Promise<void>;
	onToggleAccount: (account: AuthMenuAccount) => Promise<void>;
	onRefreshAccount: (account: AuthMenuAccount) => Promise<void>;
	onDeleteAccount: (account: AuthMenuAccount) => Promise<void>;
};

export type AuthMenuResult = "add" | "continue" | "exit";

export async function runAuthMenuOnce(args: {
	accounts: AuthMenuAccount[];
	handlers: AuthMenuHandlers;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
	now?: number;
}): Promise<AuthMenuResult> {
	const action = await chooseAuthMenuAction({
		accounts: args.accounts,
		input: args.input,
		output: args.output,
		now: args.now,
	});

	if (!action) return "exit";

	if (action.type === "add") return "add";
	if (action.type === "check-quotas") {
		await args.handlers.onCheckQuotas();
		return "continue";
	}
	if (action.type === "configure-models") {
		await args.handlers.onConfigureModels();
		return "continue";
	}
	if (action.type === "delete-all") {
		const confirm = await runConfirm({
			title: "Delete accounts",
			message: "Delete all accounts?",
			input: args.input,
			output: args.output,
			useColor: false,
		});
		if (confirm) {
			await args.handlers.onDeleteAll();
		}
		return "continue";
	}

	const account =
		action.type === "select-account"
			? action.account
			: await chooseAccountFromList({
					accounts: args.accounts,
					input: args.input,
					output: args.output,
					now: args.now,
				});
	if (!account) return "continue";

	const accountAction = await chooseAccountAction({
		account,
		input: args.input,
		output: args.output,
	});
	if (!accountAction || accountAction === "back") return "continue";
	if (accountAction === "toggle") {
		await args.handlers.onToggleAccount(account);
		return "continue";
	}
	if (accountAction === "refresh") {
		if (account.enabled !== false) {
			await args.handlers.onRefreshAccount(account);
		}
		return "continue";
	}
	if (accountAction === "delete") {
		const confirm = await runConfirm({
			title: "Delete account",
			message: `Delete ${account.email ?? "this account"}?`,
			input: args.input,
			output: args.output,
			useColor: false,
		});
		if (confirm) {
			await args.handlers.onDeleteAccount(account);
		}
		return "continue";
	}

	return "continue";
}
