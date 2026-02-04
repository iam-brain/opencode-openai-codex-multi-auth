import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/types.js";
import { AUTH_LABELS } from "../lib/constants.js";

const mockLoadAccounts = vi.fn();

vi.mock("@opencode-ai/plugin", () => {
	const createSchema = () => {
		const schema = {
			describe: () => schema,
			optional: () => schema,
		};
		return schema;
	};

	const tool = (definition: unknown) => definition;
	(tool as { schema?: unknown }).schema = {
		number: createSchema,
		boolean: createSchema,
		string: createSchema,
		array: createSchema,
	};

	return { tool };
});

vi.mock("../lib/storage.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/storage.js")>(
		"../lib/storage.js",
	);
	return {
		...actual,
		loadAccounts: () => mockLoadAccounts(),
	};
});

const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/openai-codex-accounts.json", import.meta.url),
		"utf-8",
	),
) as AccountStorageV3;

function createPluginInput() {
	return {
		client: {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		},
		project: {},
		directory: "/tmp",
		worktree: "/tmp",
		$: {},
	} as any;
}

async function loadPlugin() {
	const module = await import("../index.js");
	return module.OpenAIAuthPlugin;
}

describe("auth login workflow", () => {
	beforeEach(() => {
		mockLoadAccounts.mockReset();
	});

	it("uses separate oauth labels", () => {
		expect(AUTH_LABELS.OAUTH).toBe("Codex Oauth (browser)");
		expect(AUTH_LABELS.OAUTH_MANUAL).toBe("Codex Oauth (headless)");
	});

	it("exposes only oauth login when accounts exist", async () => {
		mockLoadAccounts.mockResolvedValueOnce(fixture);

		const OpenAIAuthPlugin = await loadPlugin();
		const plugin = await OpenAIAuthPlugin(createPluginInput());
		const labels = plugin.auth?.methods.map((method) => method.label) ?? [];

		expect(labels).toContain(AUTH_LABELS.OAUTH);
		expect(labels).not.toContain(AUTH_LABELS.API_KEY);
		expect(labels).toHaveLength(1);
	});

	it("exposes oauth/manual/api login when no accounts exist", async () => {
		mockLoadAccounts.mockResolvedValueOnce({
			...fixture,
			accounts: [],
		});

		const OpenAIAuthPlugin = await loadPlugin();
		const plugin = await OpenAIAuthPlugin(createPluginInput());
		const labels = plugin.auth?.methods.map((method) => method.label) ?? [];

		expect(labels).toEqual(
			expect.arrayContaining([
				AUTH_LABELS.OAUTH,
				AUTH_LABELS.OAUTH_MANUAL,
				AUTH_LABELS.API_KEY,
			]),
		);
		expect(labels).toHaveLength(3);
	});
});
