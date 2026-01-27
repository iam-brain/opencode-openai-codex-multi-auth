import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { withTerminalModeRestored } from "./terminal.js";
import { formatAccountLabel } from "./accounts.js";

export interface ExistingAccountLabel {
	index: number;
	email?: string;
	plan?: string;
	accountId?: string;
}

export async function promptLoginMode(
	existing: ExistingAccountLabel[],
): Promise<"add" | "fresh"> {
	return await withTerminalModeRestored(async () => {
		const rl = createInterface({ input: stdin, output: stdout });
		try {
			console.log(`\n${existing.length} account(s) saved:`);
			for (const account of existing) {
				const label = formatAccountLabel(
					{ email: account.email, plan: account.plan, accountId: account.accountId },
					account.index,
				);
				console.log(`  ${account.index + 1}. ${label}`);
			}
			console.log("");

			while (true) {
				const answer = (await rl
					.question("(a)dd new account(s) or (f)resh start? [a/f]: "))
					.trim()
					.toLowerCase();
				if (answer === "a" || answer === "add") return "add";
				if (answer === "f" || answer === "fresh") return "fresh";
				console.log("Please enter 'a' to add accounts or 'f' to start fresh.");
			}
		} finally {
			rl.close();
		}
	});
}

export async function promptAddAnotherAccount(
	currentCount: number,
	maxAccounts: number,
): Promise<boolean> {
	if (currentCount >= maxAccounts) return false;
	return await withTerminalModeRestored(async () => {
		const rl = createInterface({ input: stdin, output: stdout });
		try {
			const answer = await rl.question(
				`\nYou have ${currentCount} account(s). Add another? [y/N]: `,
			);
			return answer.trim().toLowerCase().startsWith("y");
		} finally {
			rl.close();
		}
	});
}

export async function promptOAuthCallbackValue(message: string): Promise<string> {
	return await withTerminalModeRestored(async () => {
		const rl = createInterface({ input: stdin, output: stdout });
		try {
			return (await rl.question(message)).trim();
		} finally {
			rl.close();
		}
	});
}
