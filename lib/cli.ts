import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { withTerminalModeRestored } from "./terminal.js";
import { formatAccountLabel } from "./accounts.js";

export interface ExistingAccountLabel {
	index: number;
	email?: string;
	plan?: string;
	accountId?: string;
	enabled?: boolean;
}

export async function promptLoginMode(
	existing: ExistingAccountLabel[],
): Promise<"add" | "fresh" | "manage"> {
	return await withTerminalModeRestored(async () => {
		const rl = createInterface({ input: stdin, output: stdout });
		try {
			console.log(`\n${existing.length} account(s) saved:`);
			for (const account of existing) {
				const label = formatAccountLabel(
					{ email: account.email, plan: account.plan, accountId: account.accountId },
					account.index,
				);
				const status = account.enabled === false ? " (disabled)" : "";
				console.log(`  ${account.index + 1}. ${label}${status}`);
			}
			console.log("");

			while (true) {
				const answer = (await rl
					.question("(a)dd, (f)resh start, or (m)anage accounts? [a/f/m]: "))
					.trim()
					.toLowerCase();
				if (answer === "a" || answer === "add") return "add";
				if (answer === "f" || answer === "fresh") return "fresh";
				if (answer === "m" || answer === "manage") return "manage";
				console.log("Please enter 'a', 'f', or 'm'.");
			}
		} finally {
			rl.close();
		}
	});
}

export async function promptManageAccounts(
	existing: ExistingAccountLabel[],
): Promise<number | null> {
	return await withTerminalModeRestored(async () => {
		const rl = createInterface({ input: stdin, output: stdout });
		try {
			console.log("\nManage accounts (toggle enabled):");
			for (const account of existing) {
				const label = formatAccountLabel(
					{ email: account.email, plan: account.plan, accountId: account.accountId },
					account.index,
				);
				const status = account.enabled === false ? "disabled" : "enabled";
				console.log(`  ${account.index + 1}. ${label} (${status})`);
			}
			console.log("");

			while (true) {
				const answer = (await rl
					.question("Toggle which account? (Enter to finish): "))
					.trim()
					.toLowerCase();
				if (!answer) return null;
				const parsed = Number.parseInt(answer, 10);
				if (!Number.isFinite(parsed) || parsed < 1 || parsed > existing.length) {
					console.log(`Enter a number between 1 and ${existing.length}, or press Enter to finish.`);
					continue;
				}
				return parsed - 1;
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
