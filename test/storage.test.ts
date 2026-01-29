import { describe, it, expect, afterEach, vi } from "vitest";

import lockfile from "proper-lockfile";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStoragePath, loadAccounts, saveAccounts } from "../lib/storage.js";
import type { AccountStorageV3 } from "../lib/types.js";

function loadFixture(fileName: string): AccountStorageV3 {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), "utf-8"),
	) as AccountStorageV3;
}

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

	it("saveAccounts writes via temp file and rename", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		const storage = loadFixture("openai-codex-accounts.json");

		const renameSpy = vi.spyOn(fsPromises, "rename");

		await saveAccounts(storage);

		expect(renameSpy).toHaveBeenCalledTimes(1);
		const [fromPath, toPath] = renameSpy.mock.calls[0] ?? [];
		expect(String(toPath)).toBe(storagePath);
		expect(String(fromPath)).toMatch(/openai-codex-accounts\.json\.[a-f0-9]{12}\.tmp/);

		renameSpy.mockRestore();
	});

	it("writes and reads fixture storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });

		const fixture = loadFixture("openai-codex-accounts.json");
		await saveAccounts(fixture);

		const storagePath = getStoragePath();
		const written = JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
		expect(written).toEqual(fixture);

		const loaded = await loadAccounts();
		expect(loaded).toMatchObject(fixture);
		expect(loaded?.accounts.length).toBe(fixture.accounts.length);
	});

	it("saveAccounts merges with existing storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });

		const fixture = loadFixture("openai-codex-accounts.json");
		await saveAccounts(fixture);

		const target = fixture.accounts[0]!;
		const updatedLastUsed = target.lastUsed + 5000;
		const update: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					...target,
					lastUsed: updatedLastUsed,
					rateLimitResetTimes: {
						...target.rateLimitResetTimes,
						"gpt-5.2-codex": (target.rateLimitResetTimes?.["gpt-5.2-codex"] ?? 0) + 1000,
					},
				},
			],
			activeIndex: fixture.activeIndex,
			activeIndexByFamily: fixture.activeIndexByFamily,
		};
		await saveAccounts(update);

		const loaded = await loadAccounts();
		expect(loaded?.accounts.length).toBe(fixture.accounts.length);
		const merged = loaded?.accounts.find(
			(account) =>
				account.accountId === target.accountId &&
				account.plan === target.plan &&
				account.email === target.email,
		);
		expect(merged?.lastUsed).toBe(updatedLastUsed);
		expect(merged?.rateLimitResetTimes?.["gpt-5.2-codex"]).toBe(
			(target.rateLimitResetTimes?.["gpt-5.2-codex"] ?? 0) + 1000,
		);
	});

	it("saveAccounts locks the storage file path", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });

		const storagePath = getStoragePath();
		const storage = loadFixture("openai-codex-accounts.json");
		const lockSpy = vi
			.spyOn(lockfile, "lock")
			.mockResolvedValue(async () => undefined);

		await saveAccounts(storage);

		expect(lockSpy).toHaveBeenCalled();
		expect(lockSpy.mock.calls[0]?.[0]).toBe(storagePath);

		lockSpy.mockRestore();
	});
});
