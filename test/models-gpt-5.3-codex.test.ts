import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Auth } from "@opencode-ai/sdk";
import { DEFAULT_MODEL_FAMILY } from "../lib/constants.js";

vi.mock("@opencode-ai/plugin", () => {
	const describe = () => ({
		describe: () => ({}),
	});
	const schema = {
		number: describe,
		boolean: () => ({
			optional: () => ({
				describe: () => ({}),
			}),
		}),
	};
	const tool = Object.assign((spec: unknown) => spec, { schema });
	return { tool };
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

describe("gpt-5.3-codex model metadata", () => {
	const originalXdg = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
	});

	it("keeps gpt-5.3-codex as its own metadata group and filters non-allowlisted models", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-gpt53-"));
		process.env.XDG_CONFIG_HOME = root;

		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const now = Date.now();
			const storage = {
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-token",
						accountId: "acct_123",
						email: "user@example.com",
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

				const provider = {
					models: {
						"gpt-5.3-codex": {
							id: "gpt-5.3-codex",
							name: "GPT 5.3 Codex",
							instructions: "TEMPLATE",
						},
					"o3-mini": {
						id: "o3-mini",
						name: "o3-mini",
						instructions: "OTHER",
					},
				} as Record<string, Record<string, unknown>>,
			};

			const plugin = await OpenAIAuthPlugin({
				client: {
					tui: { showToast: vi.fn() },
					auth: { set: vi.fn() },
				} as any,
			} as any);
			await (plugin as any).auth.loader(
				() => Promise.resolve(createAuth()),
				provider as any,
				);

				expect(provider.models["gpt-5.3-codex"]).toBeDefined();
				expect(provider.models["gpt-5.3-codex"]?.instructions).toBe("TEMPLATE");
				expect(provider.models["o3-mini"]).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("synthesizes gpt-5.3-codex variants on the base model", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-gpt53-variants-"));
		process.env.XDG_CONFIG_HOME = root;

		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const now = Date.now();
			const storage = {
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-token",
						accountId: "acct_123",
						email: "user@example.com",
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

				const provider = {
					models: {
						"gpt-5.3-codex": {
							id: "gpt-5.3-codex",
							instructions: "TEMPLATE",
						},
						"gpt-5.3-codex-low": {
							id: "gpt-5.3-codex-low",
							instructions: "LOW_TEMPLATE",
						},
					"o3-mini": {
						id: "o3-mini",
						instructions: "OTHER",
					},
				} as Record<string, Record<string, unknown>>,
			};

			const plugin = await OpenAIAuthPlugin({
				client: {
					tui: { showToast: vi.fn() },
					auth: { set: vi.fn() },
				} as any,
			} as any);
			await (plugin as any).auth.loader(
				() => Promise.resolve(createAuth()),
				provider as any,
			);

			expect(provider.models["gpt-5.3-codex-low"]).toBeUndefined();
			expect(provider.models["gpt-5.3-codex-medium"]).toBeUndefined();
			expect(provider.models["gpt-5.3-codex-high"]).toBeUndefined();
			expect(provider.models["gpt-5.3-codex-xhigh"]).toBeUndefined();
			expect(provider.models["gpt-5.3-codex"]).toBeDefined();
			expect(provider.models["gpt-5.3-codex"]?.variants).toBeDefined();
			expect(provider.models["gpt-5.3-codex"]?.variants?.low).toBeDefined();
			expect(provider.models["gpt-5.3-codex"]?.variants?.medium).toBeDefined();
			expect(provider.models["gpt-5.3-codex"]?.variants?.high).toBeDefined();
			expect(provider.models["gpt-5.3-codex"]?.variants?.xhigh).toBeDefined();
			expect(provider.models["o3-mini"]).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("folds gpt-5.3-codex-* metadata into base model variants", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-gpt53-standard-"));
		process.env.XDG_CONFIG_HOME = root;

		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const now = Date.now();
			const storage = {
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-token",
						accountId: "acct_123",
						email: "user@example.com",
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

				const provider = {
					models: {
						"gpt-5.3-codex": {
							id: "gpt-5.3-codex",
							name: "GPT 5.3 Codex",
						},
						"gpt-5.3-codex-xhigh": {
							id: "gpt-5.3-codex-xhigh",
							name: "GPT 5.3 Codex XHigh",
						},
					} as Record<string, Record<string, unknown>>,
				};

			const plugin = await OpenAIAuthPlugin({
				client: {
					tui: { showToast: vi.fn() },
					auth: { set: vi.fn() },
				} as any,
			} as any);
			await (plugin as any).auth.loader(
				() => Promise.resolve(createAuth()),
				provider as any,
			);

				expect(provider.models["gpt-5.3-codex"]).toBeDefined();
				expect(provider.models["gpt-5.3-codex-xhigh"]).toBeUndefined();
				expect(provider.models["gpt-5.3-codex"]?.variants?.xhigh).toBeDefined();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

	it("does not synthesize gpt-5.3-codex from gpt-5.2-codex", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-gpt53-no52clone-"));
		process.env.XDG_CONFIG_HOME = root;

		try {
			const storageDir = join(root, "opencode");
			mkdirSync(storageDir, { recursive: true });
			const now = Date.now();
			const storage = {
				version: 3,
				accounts: [
					{
						refreshToken: "refresh-token",
						accountId: "acct_123",
						email: "user@example.com",
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

			const provider = {
				models: {
					"gpt-5.2-codex": {
						id: "gpt-5.2-codex",
						name: "GPT 5.2 Codex",
						instructions: "TEMPLATE_52",
					},
				} as Record<string, Record<string, unknown>>,
			};

			const plugin = await OpenAIAuthPlugin({
				client: {
					tui: { showToast: vi.fn() },
					auth: { set: vi.fn() },
				} as any,
			} as any);
			await (plugin as any).auth.loader(
				() => Promise.resolve(createAuth()),
				provider as any,
			);

			expect(provider.models["gpt-5.3-codex"]).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
