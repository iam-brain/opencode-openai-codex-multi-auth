import type { AccountRecordV3 } from "./types.js";

export function findAccountMatchIndex(
	accounts: AccountRecordV3[],
	candidate: { accountId?: string; plan?: string; email?: string },
): number {
	// Strict identity match: accountId + email + plan. Email alone is insufficient.
	const accountId = candidate.accountId?.trim();
	const plan = candidate.plan?.trim();
	const email = candidate.email?.trim();
	if (!accountId || !plan || !email) return -1;

	return accounts.findIndex(
		(account) => account.accountId === accountId && account.plan === plan && account.email === email,
	);
}
