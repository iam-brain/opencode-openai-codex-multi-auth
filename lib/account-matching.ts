import type { AccountRecordV3 } from "./types.js";

export function findAccountMatchIndex(
	accounts: AccountRecordV3[],
	candidate: { accountId?: string; plan?: string },
): number {
	const accountId = candidate.accountId?.trim();
	if (!accountId) return -1;
	const plan = candidate.plan?.trim();

	if (plan) {
		return accounts.findIndex(
			(account) => account.accountId === accountId && account.plan === plan,
		);
	}

	return accounts.findIndex((account) => account.accountId === accountId);
}
