import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AccountStorageV3 } from "./types.js";

const STORAGE_DIR = join(homedir(), ".opencode");
const STORAGE_FILE = "openai-codex-accounts.json";

export function getStoragePath(): string {
	return join(STORAGE_DIR, STORAGE_FILE);
}

export async function loadAccounts(): Promise<AccountStorageV3 | null> {
	const filePath = getStoragePath();
	try {
		if (!existsSync(filePath)) return null;
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;

		if (!parsed || typeof parsed !== "object") return null;
		const storage = parsed as Partial<AccountStorageV3>;
		if (storage.version !== 3) return null;
		if (!Array.isArray(storage.accounts)) return null;

		const activeIndex =
			typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex)
				? Math.max(0, Math.floor(storage.activeIndex))
				: 0;
		const clampedActiveIndex =
			storage.accounts.length > 0
				? Math.min(activeIndex, storage.accounts.length - 1)
				: 0;

		return {
			version: 3,
			accounts: storage.accounts as AccountStorageV3["accounts"],
			activeIndex: clampedActiveIndex,
			activeIndexByFamily: storage.activeIndexByFamily ?? {},
		};
	} catch {
		return null;
	}
}

export async function saveAccounts(storage: AccountStorageV3): Promise<void> {
	const filePath = getStoragePath();
	await fs.mkdir(dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(storage, null, 2), "utf-8");
}
