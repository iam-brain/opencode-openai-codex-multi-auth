import { describe, it, expect, afterEach, vi } from "vitest";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getStoragePath, loadAccounts, saveAccounts } from "../lib/storage.js";
import type { AccountStorageV3 } from "../lib/types.js";

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
		const storage: AccountStorageV3 = {
			version: 3,
			accounts: [
				{
					refreshToken:
						"rt_8LhT53A4qR6fB7x1MZp2nVYzCw1Jp9aX0Qb7WkLsU2.rJ3nF1kP7xQm3vB8cY5tH2gN0pL4sD9eK1xZ6qU0",
					accountId: "8c9f67d2-1a3b-4e12-9c5d-0a12b3c4d5e6",
					email: "user.one@example.com",
					plan: "Team",
					addedAt: 1769548312122,
					lastUsed: 1769548329921,
					lastSwitchReason: "rate-limit",
					rateLimitResetTimes: {
						"gpt-5.2-codex": 1769548391664,
						"gpt-5.2-codex:gpt-5.2-codex": 1769548391664,
					},
				},
				{
					refreshToken:
						"rt_Z9mK7pL1xD3vT2qW8sN0yR6cH4bF5gJ7uQ2eV8sM1.aB9vQ0xL5cG2yT1hN6mD7sK3pR4wU8tJ0zC1fX2e",
					accountId: "8c9f67d2-1a3b-4e12-9c5d-0a12b3c4d5e6",
					email: "user.two@example.com",
					plan: "Team",
					addedAt: 1769323819476,
					lastUsed: 1769548036943,
					lastSwitchReason: "rate-limit",
					rateLimitResetTimes: {
						"gpt-5.2-codex": 1769539065554,
						"gpt-5.2-codex:gpt-5.2-codex": 1769539065554,
					},
				},
				{
					refreshToken:
						"rt_T5nV1bQ3zH7mX2rL9pS6wA0dE8fG4hJ1kQ7uY2iZ3.pD4qR8sL2vT6xC1nM0bK7yW5eU9fN3aH8jG2rX6c",
					accountId: "1f2e3d4c-5b6a-7980-91a2-b3c4d5e6f708",
					email: "user.three@example.com",
					plan: "Plus",
					addedAt: 1769525609888,
					lastUsed: 1769548019904,
					lastSwitchReason: "rate-limit",
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {
				"gpt-5.2-codex": 0,
				"codex-max": 0,
				codex: 0,
				"gpt-5.2": 0,
				"gpt-5.1": 0,
			},
		};

		const renameSpy = vi.spyOn(fsPromises, "rename");

		await saveAccounts(storage);

		expect(renameSpy).toHaveBeenCalledTimes(1);
		const [fromPath, toPath] = renameSpy.mock.calls[0] ?? [];
		expect(String(toPath)).toBe(storagePath);
		expect(String(fromPath)).toMatch(/openai-codex-accounts\.json\.tmp/);

		renameSpy.mockRestore();
	});
});
