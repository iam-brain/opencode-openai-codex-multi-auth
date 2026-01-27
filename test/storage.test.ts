import { describe, it, expect, afterEach } from "vitest";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStoragePath, loadAccounts } from "../lib/storage.js";

describe("storage", () => {
	const originalXdg = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
	});

	it("loadAccounts supports versionless v3-style object", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		const storagePath = getStoragePath();
		mkdirSync(join(root, "opencode"), { recursive: true });
		writeFileSync(
			storagePath,
			JSON.stringify(
				{
					accounts: [
						{
							refreshToken: "r1",
							accountId: "acct-123456",
							email: "user@example.com",
							plan: "Pro",
							addedAt: 123,
							lastUsed: 456,
						},
					],
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
				},
				null,
				2,
			),
			"utf-8",
		);

		const loaded = await loadAccounts();
		expect(loaded?.version).toBe(3);
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.plan).toBe("Pro");
	});

	it("loadAccounts supports legacy array-of-accounts format", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		const storagePath = getStoragePath();
		mkdirSync(join(root, "opencode"), { recursive: true });
		writeFileSync(
			storagePath,
			JSON.stringify([{ refreshToken: "r1", accountId: "acct-123456" }], null, 2),
			"utf-8",
		);

		const loaded = await loadAccounts();
		expect(loaded?.version).toBe(3);
		expect(loaded?.accounts).toHaveLength(1);
		expect(typeof loaded?.accounts[0]?.addedAt).toBe("number");
		expect(typeof loaded?.accounts[0]?.lastUsed).toBe("number");
	});
});
