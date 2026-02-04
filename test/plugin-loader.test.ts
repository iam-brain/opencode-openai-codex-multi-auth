import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Auth } from "@opencode-ai/sdk";
import { AUTH_LABELS, JWT_CLAIM_PATH } from "../lib/constants.js";
import { AccountManager } from "../lib/accounts.js";
import { createJwt } from "./helpers/jwt.js";

let mockedTokenResult: any;

vi.mock("@opencode-ai/plugin", () => {
	const describe = () => ({
		describe: () => ({})
	});
	const schema = {
		number: describe,
		boolean: () => ({
			optional: () => ({
				describe: () => ({})
			})
		}),
	};
	const tool = Object.assign((spec: unknown) => spec, { schema });
	return { tool };
});

vi.mock("../lib/auth/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth/auth.js")>("../lib/auth/auth.js");
	return {
		...actual,
		createAuthorizationFlow: vi.fn(async () => ({
			pkce: { verifier: "verifier" },
			state: "state",
			url: "http://example.com",
		})),
		parseAuthorizationInputForFlow: vi.fn(() => ({
			stateStatus: "match",
			code: "code",
		})),
		exchangeAuthorizationCode: vi.fn(async () => mockedTokenResult),
	};
});

import { OpenAIAuthPlugin } from "../index.js";

function createAuth(): Auth {
	return {
		type: "oauth",
		access: "access",
		refresh: "refresh",
		expires: Date.now() + 60_000,
	};
}

describe("OpenAIAuthPlugin loader", () => {
	const originalXdg = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
	});

	it("persists accountId from id token when access token lacks it", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-persist-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const accountId = "acct_idtoken";
			const idToken = createJwt({
				[JWT_CLAIM_PATH]: {
					chatgpt_account_id: accountId,
				},
			});
			const accessToken = createJwt({});
			mockedTokenResult = {
				type: "success",
				access: accessToken,
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				idToken,
			};

			const client = {
				tui: { showToast: vi.fn() },
				auth: { set: vi.fn() },
			};

			const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
			const manualMethod = (plugin as any).auth.methods.find(
				(method: any) => method.label === AUTH_LABELS.OAUTH_MANUAL,
			);
			expect(manualMethod).toBeTruthy();
			const flow = await manualMethod.authorize();
			await flow.callback("code=abc&state=state");

			const saved = JSON.parse(
				readFileSync(join(root, "opencode", "openai-codex-accounts.json"), "utf-8"),
			);
			expect(saved.accounts[0].accountId).toBe(accountId);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("codex-status is read-only (does not refresh or save)", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-status-"));
		process.env.XDG_CONFIG_HOME = root;
		let refreshSpy: any;
		let saveSpy: any;
		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const now = Date.now();
			const storage = {
				version: 3,
				accounts: [
					{
						refreshToken: "status-refresh",
						accountId: "acct_status",
						email: "status@example.com",
						plan: "Plus",
						enabled: true,
						addedAt: now,
						lastUsed: now,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			};
			writeFileSync(
				join(storageDir, "openai-codex-accounts.json"),
				JSON.stringify(storage, null, 2),
				"utf-8",
			);

			refreshSpy = vi
				.spyOn(AccountManager.prototype, "refreshAccountWithFallback")
				.mockResolvedValue({ type: "failed" } as any);
			saveSpy = vi.spyOn(AccountManager.prototype, "saveToDisk").mockResolvedValue();

			const client = {
				tui: { showToast: vi.fn() },
				auth: { set: vi.fn() },
			};

			const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
			await (plugin as any).tool["codex-status"].execute({});

			expect(refreshSpy).not.toHaveBeenCalled();
			expect(saveSpy).not.toHaveBeenCalled();
		} finally {
			refreshSpy?.mockRestore();
			saveSpy?.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns fetch handler when only legacy accounts exist", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-legacy-"));
		process.env.XDG_CONFIG_HOME = root;

		const storageDir = join(root, "opencode");
		mkdirSync(storageDir, { recursive: true });
		const now = Date.now();
		const legacyStorage = {
			version: 3,
			accounts: [
				{
					refreshToken: "legacy-refresh",
					addedAt: now,
					lastUsed: now,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(
			join(storageDir, "openai-codex-accounts.json"),
			JSON.stringify(legacyStorage, null, 2),
			"utf-8",
		);

		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		};

		const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
		const result = await (plugin as any).auth.loader(() => Promise.resolve(createAuth()), {} as any);

		expect(result).toHaveProperty("fetch");
		await rmSync(root, { recursive: true, force: true });
	});

	it("removes the correct account when legacy records exist", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-remove-"));
		process.env.XDG_CONFIG_HOME = root;

		const storageDir = join(root, "opencode");
		mkdirSync(storageDir, { recursive: true });
		const now = Date.now();
		const legacyAccount = {
			refreshToken: "legacy-refresh",
			addedAt: now,
			lastUsed: now,
			enabled: true,
		};
		const fullAccount = {
			refreshToken: "full-refresh",
			accountId: "acct_123",
			email: "user@example.com",
			plan: "Plus",
			addedAt: now,
			lastUsed: now,
			enabled: true,
		};
		const storage = {
			version: 3,
			accounts: [legacyAccount, fullAccount],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		writeFileSync(
			join(storageDir, "openai-codex-accounts.json"),
			JSON.stringify(storage, null, 2),
			"utf-8",
		);

		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		};

		const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
		await (plugin as any).auth.loader(() => Promise.resolve(createAuth()), {} as any);

		const result = await (plugin as any).tool["codex-remove-account"].execute({ index: 2, confirm: true });
		expect(result).toContain("Removed");

		const updated = JSON.parse(
			readFileSync(join(storageDir, "openai-codex-accounts.json"), "utf-8"),
		);
		expect(updated.accounts).toHaveLength(1);
		expect(updated.accounts[0].refreshToken).toBe("legacy-refresh");

		await rmSync(root, { recursive: true, force: true });
	});
});
