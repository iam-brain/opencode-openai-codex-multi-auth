import { describe, it, expect, afterEach, vi } from "vitest";

import lockfile from "proper-lockfile";
import {
	copyFileSync,
	existsSync,
	readdirSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	getStoragePath,
	inspectAccountsFile,
	loadAccounts,
	backupAccountsFile,
	autoQuarantineCorruptAccountsFile,
	writeQuarantineFile,
	quarantineAccounts,
	saveAccounts,
	toggleAccountEnabled,
} from "../lib/storage.js";
import type { AccountStorageV3 } from "../lib/types.js";

function loadFixture(fileName: string): AccountStorageV3 {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), "utf-8"),
	) as AccountStorageV3;
}

const fixture = loadFixture("openai-codex-accounts.json");
const accountOne = fixture.accounts[0]!;
const accountTwo = fixture.accounts[1]!;
const backupFixtureUrl = new URL(
	"./fixtures/backup/openai-codex-accounts.backup.json",
	import.meta.url,
);

function seedStorageFromBackup(storagePath: string): AccountStorageV3 {
	copyFileSync(backupFixtureUrl, storagePath);
	return JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
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
		const base = seedStorageFromBackup(storagePath);
		writeFileSync(
			storagePath,
			JSON.stringify(
				{
					accounts: [
						{
							...base.accounts[0]!,
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
		expect(loaded?.accounts[0]?.plan).toBe(accountOne.plan);
	});

	it("loadAccounts supports legacy array-of-accounts format", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		const storagePath = getStoragePath();
		mkdirSync(join(root, "opencode"), { recursive: true });
		const base = seedStorageFromBackup(storagePath);
		writeFileSync(
			storagePath,
			JSON.stringify([
				{
					...base.accounts[0]!,
					addedAt: base.accounts[0]!.addedAt,
					lastUsed: base.accounts[0]!.lastUsed,
				},
			], null, 2),
			"utf-8",
		);

		const loaded = await loadAccounts();
		expect(loaded?.version).toBe(3);
		expect(loaded?.accounts).toHaveLength(1);
		expect(typeof loaded?.accounts[0]?.addedAt).toBe("number");
		expect(typeof loaded?.accounts[0]?.lastUsed).toBe("number");
	});

	it("loadAccounts preserves legacy entries missing identity fields", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		const storagePath = getStoragePath();
		mkdirSync(join(root, "opencode"), { recursive: true });
		const base = seedStorageFromBackup(storagePath);
		writeFileSync(
			storagePath,
			JSON.stringify(
				{
					accounts: [
						{
							...base.accounts[0]!,
							addedAt: 100,
							lastUsed: 200,
						},
						{
							...base.accounts[1]!,
							email: undefined,
							plan: undefined,
							addedAt: 100,
							lastUsed: 200,
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
		expect(loaded?.accounts).toHaveLength(2);
		expect(loaded?.accounts[0]?.accountId).toBe(accountOne.accountId);
		expect(loaded?.accounts[1]?.email).toBeUndefined();
	});

	it("saveAccounts writes via temp file and rename", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		seedStorageFromBackup(storagePath);
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
		seedStorageFromBackup(getStoragePath());

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
		seedStorageFromBackup(getStoragePath());

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

	it("saveAccounts preserves refresh tokens when requested", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();

		const newerToken = `${accountOne.refreshToken}-new`;
		const existing: AccountStorageV3 = {
			version: 3,
			accounts: [{ ...accountOne, refreshToken: newerToken }],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(storagePath, JSON.stringify(existing, null, 2), "utf-8");

		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [{ ...accountOne }],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		await saveAccounts(incoming, { preserveRefreshTokens: true });

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.refreshToken).toBe(newerToken);
	});

	it("saveAccounts replaces storage when requested", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		seedStorageFromBackup(storagePath);

		const replacement: AccountStorageV3 = {
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		await saveAccounts(replacement, { replace: true });

		const loaded = JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
		expect(loaded.accounts).toHaveLength(0);
	});

	it("backupAccountsFile sets private mode and prunes old backups", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		seedStorageFromBackup(storagePath);

		for (let i = 0; i < 30; i++) {
			writeFileSync(`${storagePath}.bak-${1000 + i}`, "{}", "utf-8");
		}
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
		let backupPath: string | null = null;
		try {
			backupPath = await backupAccountsFile();
		} finally {
			nowSpy.mockRestore();
		}
		expect(backupPath).toBeTruthy();
		if (!backupPath) return;
		if (process.platform !== "win32") {
			const stat = await fsPromises.stat(backupPath);
			expect(stat.mode & 0o777).toBe(0o600);
		}

		const backupFiles = readdirSync(join(root, "opencode")).filter((name) =>
			name.startsWith("openai-codex-accounts.json.bak-"),
		);
		expect(backupFiles.length).toBeLessThanOrEqual(20);
		expect(backupFiles.some((name) => name.includes("bak-10000"))).toBe(true);
	});

	it("saveAccounts preserves disabled flag when incoming omits enabled", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();

		const disabledAccount = { ...accountOne, enabled: false };
		const existing: AccountStorageV3 = {
			version: 3,
			accounts: [disabledAccount],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(storagePath, JSON.stringify(existing, null, 2), "utf-8");

		const { enabled: _ignored, ...base } = accountOne;
		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					...base,
					refreshToken: `${accountOne.refreshToken}-updated`,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		await saveAccounts(incoming);

		const loaded = await loadAccounts();
		expect(loaded?.accounts[0]?.enabled).toBe(false);
	});

	it("saveAccounts merges legacy records without duplication", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();

		const legacy = {
			...accountOne,
			accountId: undefined,
			email: undefined,
			plan: undefined,
		};
		const existing: AccountStorageV3 = {
			version: 3,
			accounts: [legacy],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(storagePath, JSON.stringify(existing, null, 2), "utf-8");

		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [legacy],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		await saveAccounts(incoming);

		const finalStorage = JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
		const matches = finalStorage.accounts.filter(
			(entry) => entry.refreshToken === legacy.refreshToken,
		);
		expect(matches).toHaveLength(1);
	});

	it("saveAccounts merges legacy updates by refresh token", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();

		const legacy = {
			...accountOne,
			accountId: undefined,
			email: undefined,
			plan: undefined,
			lastUsed: accountOne.lastUsed + 1000,
		};
		const existing: AccountStorageV3 = {
			version: 3,
			accounts: [legacy],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(storagePath, JSON.stringify(existing, null, 2), "utf-8");

		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					...legacy,
					email: "legacy@example.com",
					lastUsed: legacy.lastUsed - 500,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		await saveAccounts(incoming);

		const finalStorage = JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
		const merged = finalStorage.accounts.find(
			(entry) => entry.refreshToken === legacy.refreshToken,
		);
		expect(merged?.email).toBe("legacy@example.com");
	});

	it("saveAccounts remaps activeIndexByFamily to merged accounts", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();

		const existing: AccountStorageV3 = {
			version: 3,
			accounts: [accountOne, accountTwo],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(storagePath, JSON.stringify(existing, null, 2), "utf-8");

		const incoming: AccountStorageV3 = {
			version: 3,
			accounts: [accountTwo, accountOne],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		await saveAccounts(incoming);

		const finalStorage = JSON.parse(readFileSync(storagePath, "utf-8")) as AccountStorageV3;
		expect(finalStorage.activeIndexByFamily?.codex).toBe(1);
	});

	it("saveAccounts maps activeIndex to merged account", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		seedStorageFromBackup(getStoragePath());

		await saveAccounts({
			...fixture,
			accounts: [accountOne, accountTwo],
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		});

		await saveAccounts({
			version: 3,
			accounts: [accountTwo],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		});

		const loaded = await loadAccounts();
		const mappedIndex = loaded?.accounts.findIndex(
			(account) =>
				account.accountId === accountTwo.accountId &&
				account.plan === accountTwo.plan &&
				account.email === accountTwo.email,
		);
		expect(mappedIndex).toBeGreaterThanOrEqual(0);
		expect(loaded?.activeIndex).toBe(mappedIndex);
	});

	it("loadAccounts drops duplicate refresh tokens", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		const storagePath = getStoragePath();
		mkdirSync(join(root, "opencode"), { recursive: true });
		seedStorageFromBackup(storagePath);
		writeFileSync(
			storagePath,
			JSON.stringify(
				{
					accounts: [
						{
							...accountOne,
							refreshToken: accountOne.refreshToken,
							addedAt: 100,
							lastUsed: 200,
						},
						{
							...accountTwo,
							refreshToken: accountOne.refreshToken,
							addedAt: 100,
							lastUsed: 50,
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
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.accounts[0]?.accountId).toBe(accountOne.accountId);
	});

	it("loadAccounts remaps active index after dedupe", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;

		const storagePath = getStoragePath();
		mkdirSync(join(root, "opencode"), { recursive: true });
		seedStorageFromBackup(storagePath);
		writeFileSync(
			storagePath,
			JSON.stringify(
				{
					accounts: [
						{
							...accountOne,
							refreshToken: accountOne.refreshToken,
							addedAt: 100,
							lastUsed: 200,
						},
						{
							...accountTwo,
							refreshToken: accountOne.refreshToken,
							addedAt: 100,
							lastUsed: 50,
						},
					],
					activeIndex: 1,
					activeIndexByFamily: { codex: 1 },
				},
				null,
				2,
			),
			"utf-8",
		);

		const loaded = await loadAccounts();
		expect(loaded?.accounts).toHaveLength(1);
		expect(loaded?.activeIndex).toBe(0);
		expect(loaded?.activeIndexByFamily?.codex).toBe(0);
	});

	it("saveAccounts locks the storage file path", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });

		const storagePath = getStoragePath();
		seedStorageFromBackup(storagePath);
		const storage = loadFixture("openai-codex-accounts.json");
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (path) => {
			expect(existsSync(path)).toBe(true);
			return async () => undefined;
		});

		await saveAccounts(storage);

		expect(lockSpy).toHaveBeenCalled();
		expect(lockSpy.mock.calls[0]?.[0]).toBe(storagePath);

		lockSpy.mockRestore();
	});

	it("saveAccounts does not re-lock during legacy migration", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		mkdirSync(join(root, ".opencode"), { recursive: true });
		const legacyPath = join(root, ".opencode", "openai-codex-accounts.json");
		writeFileSync(
			legacyPath,
			JSON.stringify({ version: 3, accounts: [{ ...accountOne }], activeIndex: 0 }, null, 2),
			"utf-8",
		);

		vi.resetModules();
		vi.doMock("node:os", async () => {
			const actual = await vi.importActual<typeof import("node:os")>("node:os");
			return { ...actual, homedir: () => root };
		});
		try {
			const storageModule = await import("../lib/storage.js");
			const storagePath = storageModule.getStoragePath();
			const storage = loadFixture("openai-codex-accounts.json");
			let heldLocks = 0;
			let nestedAttempt = false;
			const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (path) => {
				expect(path).toBe(storagePath);
				heldLocks += 1;
				if (heldLocks > 1) nestedAttempt = true;
				return async () => {
					heldLocks -= 1;
				};
			});
			try {
				await storageModule.saveAccounts(storage);
				expect(nestedAttempt).toBe(false);
				expect(lockSpy).toHaveBeenCalledTimes(1);
			} finally {
				lockSpy.mockRestore();
			}
		} finally {
			vi.doUnmock("node:os");
		}
	});

	it("saveAccounts ensures file exists before locking", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });

		const storagePath = getStoragePath();
		// Do not create the storage file upfront.
		const storage = loadFixture("openai-codex-accounts.json");
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (path) => {
			expect(path).toBe(storagePath);
			expect(existsSync(path)).toBe(true);
			return async () => undefined;
		});
		try {
			await saveAccounts(storage);
			expect(lockSpy).toHaveBeenCalled();
		} finally {
			lockSpy.mockRestore();
		}
	});

	it("saveAccounts cleans up temp file on rename failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });

		const storagePath = getStoragePath();
		const storage = loadFixture("openai-codex-accounts.json");
		const renameSpy = vi
			.spyOn(fsPromises, "rename")
			.mockRejectedValueOnce(new Error("rename failed"));
		try {
			await expect(saveAccounts(storage)).rejects.toThrow("rename failed");
			const tmpFiles = readdirSync(join(root, "opencode")).filter((name) => name.endsWith(".tmp"));
			expect(tmpFiles).toEqual([]);
		} finally {
			renameSpy.mockRestore();
		}
	});

	it("loadAccounts migration locks the storage file path", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		const originalHome = process.env.HOME;
		process.env.XDG_CONFIG_HOME = root;
		process.env.HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		mkdirSync(join(root, ".opencode"), { recursive: true });

		const storagePath = getStoragePath();
		const legacyPath = join(root, ".opencode", "openai-codex-accounts.json");
		seedStorageFromBackup(storagePath);
		writeFileSync(
			legacyPath,
			JSON.stringify({ version: 3, accounts: [{ ...accountOne }], activeIndex: 0 }, null, 2),
			"utf-8",
		);
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async (path) => {
			expect(existsSync(path)).toBe(true);
			return async () => undefined;
		});
		try {
			await loadAccounts();
			expect(lockSpy).toHaveBeenCalled();
			// Should lock the new storage path when migrating.
			expect(lockSpy.mock.calls.some((call) => call[0] === storagePath)).toBe(true);
		} finally {
			lockSpy.mockRestore();
			process.env.HOME = originalHome;
		}
	});

	it("legacy migration writes storage atomically", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		const originalHome = process.env.HOME;
		process.env.XDG_CONFIG_HOME = root;
		process.env.HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		mkdirSync(join(root, ".opencode"), { recursive: true });

		const storagePath = getStoragePath();
		const legacyPath = join(root, ".opencode", "openai-codex-accounts.json");
		writeFileSync(storagePath, JSON.stringify({ version: 3, accounts: "invalid" }, null, 2), "utf-8");
		writeFileSync(
			legacyPath,
			JSON.stringify({ version: 3, accounts: [{ ...accountOne }], activeIndex: 0 }, null, 2),
			"utf-8",
		);
		const renameSpy = vi.spyOn(fsPromises, "rename");
		try {
			await loadAccounts();
			expect(renameSpy).toHaveBeenCalled();
		} finally {
			renameSpy.mockRestore();
			process.env.HOME = originalHome;
		}
	});

	it("toggleAccountEnabled flips enabled state", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			accounts: [
				{ ...accountOne },
				{ ...accountTwo, enabled: true },
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		const firstToggle = toggleAccountEnabled(storage, 0);
		expect(firstToggle?.accounts[0]?.enabled).toBe(false);
		const secondToggle = toggleAccountEnabled(firstToggle!, 0);
		expect(secondToggle?.accounts[0]?.enabled).toBe(true);

		const toggledSecond = toggleAccountEnabled(storage, 1);
		expect(toggledSecond?.accounts[1]?.enabled).toBe(false);
	});

	it("inspectAccountsFile flags corrupt json", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		writeFileSync(storagePath, "{", "utf-8");

		const result = await inspectAccountsFile();

		expect(result.status).toBe("corrupt-file");
	});

	it("inspectAccountsFile reports corrupt + legacy entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		writeFileSync(
			storagePath,
			JSON.stringify(
				{
					accounts: [
						{ ...accountOne },
						{ ...accountTwo, refreshToken: "" },
						{ ...accountTwo, plan: undefined },
					],
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
				},
				null,
				2,
			),
			"utf-8",
		);

		const result = await inspectAccountsFile();

		expect(result.status).toBe("needs-repair");
		expect(result.corruptEntries).toHaveLength(1);
		expect(result.legacyEntries).toHaveLength(1);
	});

	it("quarantineAccounts writes file and removes entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		seedStorageFromBackup(storagePath);
		const storage = loadFixture("openai-codex-accounts.json");

		const result = await quarantineAccounts(storage, [storage.accounts[0]!], "test");

		expect(result.quarantinePath).toBeTruthy();
		expect(existsSync(result.quarantinePath)).toBe(true);
		const payload = JSON.parse(readFileSync(result.quarantinePath, "utf-8")) as {
			records?: unknown[];
		};
		expect(payload.records).toHaveLength(1);
		const loaded = await loadAccounts();
		expect(loaded?.accounts.length).toBe(storage.accounts.length - 1);
	});

	it("writeQuarantineFile sets private permissions (0600)", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		writeFileSync(storagePath, JSON.stringify({ version: 3, accounts: [], activeIndex: 0 }, null, 2), "utf-8");

		const quarantinePath = await writeQuarantineFile([{ refreshToken: accountOne.refreshToken }], "test");
		expect(existsSync(quarantinePath)).toBe(true);
		if (process.platform !== "win32") {
			const stat = await fsPromises.stat(quarantinePath);
			expect(stat.mode & 0o777).toBe(0o600);
		}
	});

	it("writeQuarantineFile limits the number of quarantine files", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		writeFileSync(storagePath, JSON.stringify({ version: 3, accounts: [], activeIndex: 0 }, null, 2), "utf-8");

		for (let i = 0; i < 30; i++) {
			writeFileSync(`${storagePath}.quarantine-${1000 + i}.json`, "{}", "utf-8");
		}
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
		try {
			await writeQuarantineFile([], "test");
		} finally {
			nowSpy.mockRestore();
		}

		const quarantineFiles = readdirSync(join(root, "opencode")).filter((name) =>
			name.startsWith("openai-codex-accounts.json.quarantine-"),
		);
		expect(quarantineFiles.length).toBeLessThanOrEqual(20);
		expect(quarantineFiles.some((name) => name.includes("quarantine-10000"))).toBe(true);
	});

	it("autoQuarantineCorruptAccountsFile quarantines and resets corrupt JSON", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-storage-"));
		process.env.XDG_CONFIG_HOME = root;
		mkdirSync(join(root, "opencode"), { recursive: true });
		const storagePath = getStoragePath();
		for (let i = 0; i < 30; i++) {
			writeFileSync(`${storagePath}.quarantine-${1000 + i}.json`, "{}", "utf-8");
		}
		writeFileSync(storagePath, "{", "utf-8");
		if (process.platform !== "win32") {
			await fsPromises.chmod(storagePath, 0o644);
		}

		const quarantinePath = await autoQuarantineCorruptAccountsFile();
		expect(quarantinePath).toBeTruthy();
		if (!quarantinePath) return;
		expect(readFileSync(quarantinePath, "utf-8")).toBe("{");
		if (process.platform !== "win32") {
			const stat = await fsPromises.stat(quarantinePath);
			expect(stat.mode & 0o777).toBe(0o600);
		}
		const quarantineFiles = readdirSync(join(root, "opencode")).filter((name) =>
			name.startsWith("openai-codex-accounts.json.quarantine-"),
		);
		expect(quarantineFiles.length).toBeLessThanOrEqual(20);
		const after = JSON.parse(readFileSync(storagePath, "utf-8")) as { accounts?: unknown[] };
		expect(after.accounts).toEqual([]);
	});
});
