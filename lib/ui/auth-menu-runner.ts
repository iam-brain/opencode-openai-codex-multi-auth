import type { AccountInfo } from "./auth-menu.js";
import { showAccountDetails, showAuthMenu, selectAccount } from "./auth-menu.js";

export type AuthMenuHandlers = {
	onCheckQuotas: () => Promise<void>;
	onConfigureModels: () => Promise<void>;
	onDeleteAll: () => Promise<void>;
	onToggleAccount: (account: AccountInfo) => Promise<void>;
	onRefreshAccount: (account: AccountInfo) => Promise<void>;
	onDeleteAccount: (account: AccountInfo) => Promise<void>;
};

export type AuthMenuResult = "add" | "continue" | "exit";

export async function runAuthMenuOnce(args: {
	accounts: AccountInfo[];
	handlers: AuthMenuHandlers;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}): Promise<AuthMenuResult> {
	const action = await showAuthMenu(args.accounts, {
		input: args.input,
		output: args.output,
	});

	if (action.type === "cancel") return "exit";
	if (action.type === "add") return "add";
	if (action.type === "check") {
		await args.handlers.onCheckQuotas();
		return "continue";
	}
	if (action.type === "configure-models") {
		await args.handlers.onConfigureModels();
		return "continue";
	}
	if (action.type === "delete-all") {
		await args.handlers.onDeleteAll();
		return "continue";
	}

	const account =
		action.type === "select-account"
			? action.account
			: await selectAccount(args.accounts, {
					input: args.input,
					output: args.output,
				});
	if (!account) return "continue";

	const accountAction = await showAccountDetails(account, {
		input: args.input,
		output: args.output,
	});

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
		await args.handlers.onDeleteAccount(account);
		return "continue";
	}

	return "continue";
}
