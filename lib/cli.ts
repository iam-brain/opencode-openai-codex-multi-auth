import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface ExistingAccountLabel {
	index: number;
	email?: string;
	accountId?: string;
}

export async function promptLoginMode(
	existing: ExistingAccountLabel[],
): Promise<"add" | "fresh"> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const lines: string[] = [];
		lines.push("\nExisting accounts:\n");
		for (const account of existing) {
			const label =
				account.email ??
				(account.accountId ? `id:${account.accountId}` : "(unknown)");
			lines.push(`  ${account.index + 1}. ${label}`);
		}
		lines.push("");
		lines.push("(a)dd new account(s) or (f)resh start? [a/f]: ");

		const answer = (await rl.question(lines.join("\n"))).trim().toLowerCase();
		if (answer.startsWith("f")) return "fresh";
		return "add";
	} finally {
		rl.close();
	}
}

export async function promptAddAnotherAccount(
	currentCount: number,
	maxAccounts: number,
): Promise<boolean> {
	if (currentCount >= maxAccounts) return false;
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await rl.question(
			`\nYou have ${currentCount} account(s). Add another? [y/N]: `,
		);
		return answer.trim().toLowerCase().startsWith("y");
	} finally {
		rl.close();
	}
}
