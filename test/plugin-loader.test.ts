import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Auth } from "@opencode-ai/sdk";
import { AUTH_LABELS, DEFAULT_MODEL_FAMILY, JWT_CLAIM_PATH } from "../lib/constants.js";
import * as logger from "../lib/logger.js";
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

	it("does not register codex tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-tools-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const client = {
				tui: { showToast: vi.fn() },
				auth: { set: vi.fn() },
			};
			const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
			const toolKeys = Object.keys((plugin as any).tool ?? {});
			expect(toolKeys.some((key) => key.startsWith("codex-"))).toBe(false);
		} finally {
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

	it("logs toast failures during fetch", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-toast-"));
		process.env.XDG_CONFIG_HOME = root;
		const originalFetch = global.fetch;
		const logSpy = vi.spyOn(logger, "logCritical").mockImplementation(() => undefined);
		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const now = Date.now();
			const storage = {
				version: 3,
				accounts: [
					{
						refreshToken: "toast-refresh",
						accountId: "acct_toast",
						email: "toast@example.com",
						plan: "Plus",
						enabled: true,
						addedAt: now,
						lastUsed: now,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { [DEFAULT_MODEL_FAMILY]: 0 },
			};
			writeFileSync(
				join(storageDir, "openai-codex-accounts.json"),
				JSON.stringify(storage, null, 2),
				"utf-8",
			);

			global.fetch = vi
				.fn()
				.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

			const client = {
				tui: { showToast: vi.fn().mockRejectedValue(new Error("toast failed")) },
				auth: { set: vi.fn() },
			};
			const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
			const authConfig = await (plugin as any).auth.loader(
				async () => ({
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				}),
				{} as any,
			);
			await authConfig.fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1", prompt_cache_key: "sess_toast" }),
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(logSpy).toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			global.fetch = originalFetch;
			rmSync(root, { recursive: true, force: true });
		}
	});


	it("keeps existing accounts unchanged in non-TTY authorize flow", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-manage-"));
		process.env.XDG_CONFIG_HOME = root;
		process.env.OPENCODE_NO_BROWSER = "1";
		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const storagePath = join(storageDir, "openai-codex-accounts.json");
			const fixture = JSON.parse(
				readFileSync(
					new URL("./fixtures/openai-codex-accounts.json", import.meta.url),
					"utf-8",
				),
			);
			const baseStorage = {
				version: 3,
				accounts: [fixture.accounts[0], fixture.accounts[1]],
				activeIndex: 0,
				activeIndexByFamily: fixture.activeIndexByFamily,
			};
			writeFileSync(storagePath, JSON.stringify(baseStorage, null, 2), "utf-8");

			const client = {
				tui: { showToast: vi.fn() },
				auth: { set: vi.fn() },
			};
			const plugin = await OpenAIAuthPlugin({ client: client as any } as any);
			const oauthMethod = (plugin as any).auth.methods.find(
				(method: any) => method.label === AUTH_LABELS.OAUTH,
			);
			await oauthMethod.authorize({});

			const updated = JSON.parse(readFileSync(storagePath, "utf-8"));
			expect(updated.accounts).toEqual(baseStorage.accounts);
			expect(updated.activeIndex).toBe(baseStorage.activeIndex);
		} finally {
			delete process.env.OPENCODE_NO_BROWSER;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
