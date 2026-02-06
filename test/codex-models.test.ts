import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalXdg = process.env.XDG_CONFIG_HOME;

async function loadModule() {
	vi.resetModules();
	return import("../lib/prompts/codex-models.js");
}

describe("codex model metadata resolver", () => {
	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
		vi.restoreAllMocks();
	});

	it("uses server /codex/models as primary source", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-server-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from server",
										personality_pragmatic: "Pragmatic from server",
									},
								},
							},
						],
					}),
					{ status: 200, headers: { etag: '"abc"' } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(mockFetch).toHaveBeenCalled();
		expect(mockFetch.mock.calls[0]?.[0]?.toString()).toContain("/codex/models");
		expect(defaults.onlineDefaultPersonality).toBeUndefined();
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from server");

		rmSync(root, { recursive: true, force: true });
	});

	it("uses cached models when network refresh fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-cache-fallback-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const seedFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.3-codex",
							model_messages: {
								instructions_template: "Base {{ personality }}",
								instructions_variables: {
									personality_default: "",
									personality_friendly: "Friendly from cache seed",
									personality_pragmatic: "Pragmatic from cache seed",
								},
							},
						},
					],
				}),
				{ status: 200 },
			);
		});

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: seedFetch as unknown as typeof fetch,
		});

		const failingFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				throw new Error("offline");
			}
			throw new Error(`unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: failingFetch as unknown as typeof fetch,
			forceRefresh: true,
		});

		expect(defaults.personalityMessages?.friendly).toBe("Friendly from cache seed");
		rmSync(root, { recursive: true, force: true });
	});

	it("attempts server refresh before using fresh cache", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-online-first-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const seedFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.3-codex",
							model_messages: {
								instructions_template: "Base {{ personality }}",
								instructions_variables: {
									personality_default: "",
									personality_friendly: "Friendly from stale cache",
									personality_pragmatic: "Pragmatic from stale cache",
								},
							},
						},
					],
				}),
				{ status: 200 },
			);
		});

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: seedFetch as unknown as typeof fetch,
		});

		const refreshFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from server refresh",
										personality_pragmatic: "Pragmatic from server refresh",
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: refreshFetch as unknown as typeof fetch,
		});

		expect(refreshFetch).toHaveBeenCalled();
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from server refresh");
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to cached target model when server catalog omits it", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-server-miss-cache-hit-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const seedFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.4-codex",
							model_messages: {
								instructions_template: "Base {{ personality }}",
								instructions_variables: {
									personality_default: "",
									personality_friendly: "Friendly from cached target",
									personality_pragmatic: "Pragmatic from cached target",
								},
							},
						},
					],
				}),
				{ status: 200 },
			);
		});

		await getCodexModelRuntimeDefaults("gpt-5.4-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: seedFetch as unknown as typeof fetch,
		});

		const serverMissFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from server other model",
										personality_pragmatic: "Pragmatic from server other model",
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.4-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: serverMissFetch as unknown as typeof fetch,
		});

		expect(defaults.personalityMessages?.friendly).toBe("Friendly from cached target");
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to GitHub when server catalog succeeds but lacks requested model", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-server-miss-github-hit-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from server only",
										personality_pragmatic: "Pragmatic from server only",
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.9.9" }), {
					status: 200,
				});
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/rust-v9.9.9")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.4-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from GitHub targeted fallback",
										personality_pragmatic: "Pragmatic from GitHub targeted fallback",
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.4-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(defaults.personalityMessages?.friendly).toBe(
			"Friendly from GitHub targeted fallback",
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to GitHub models when cache is missing and server fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-github-fallback-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				throw new Error("server offline");
			}
			if (url.includes("/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.9.9" }), {
					status: 200,
				});
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/rust-v9.9.9")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.4-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from GitHub",
										personality_pragmatic: "Pragmatic from GitHub",
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.4-codex", {
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(defaults.onlineDefaultPersonality).toBeUndefined();
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from GitHub");
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to GitHub main when release tag lookup fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-github-main-fallback-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("/codex/models")) {
				throw new Error("server offline");
			}
			if (url.includes("/releases/latest")) {
				throw new Error("release api offline");
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/main")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.4-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personality_default: "",
										personality_friendly: "Friendly from GitHub main",
										personality_pragmatic: "Pragmatic from GitHub main",
									},
								},
							},
						],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.4-codex", {
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(defaults.personalityMessages?.friendly).toBe("Friendly from GitHub main");
		rmSync(root, { recursive: true, force: true });
	});

	it("uses explicit online personality default when provided by model metadata", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-online-default-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.3-codex",
							model_messages: {
								instructions_template: "Base {{ personality }}",
								instructions_variables: {
									personality: "PrAgMaTiC",
									personality_default: "",
									personality_friendly: "Friendly from server",
									personality_pragmatic: "Pragmatic from server",
								},
							},
						},
					],
				}),
				{ status: 200 },
			);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(defaults.onlineDefaultPersonality).toBe("pragmatic");
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to static template defaults when server/cache/GitHub are unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-static-fallback-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const failingFetch = vi.fn(async () => {
			throw new Error("offline");
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.9-codex", {
			fetchImpl: failingFetch as unknown as typeof fetch,
		});

		expect(defaults.onlineDefaultPersonality).toBeUndefined();
		expect(defaults.staticDefaultPersonality).toBe("none");
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves static template files from packaged dist path", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-dist-static-path-"));
		const packageRoot = join(root, "package");
		const configDir = join(packageRoot, "config");
		const moduleDir = join(packageRoot, "dist", "lib", "prompts");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(moduleDir, { recursive: true });
		writeFileSync(
			join(configDir, "opencode-modern.json"),
			JSON.stringify({
				provider: {
					openai: {
						models: {
							"gpt-5.9-codex": {
								options: { personality: "friendly" },
							},
						},
					},
				},
			}),
			"utf8",
		);

		const { __internal } = await loadModule();
		const defaults = __internal.readStaticTemplateDefaults(moduleDir);
		expect(defaults.get("gpt-5.9-codex")?.personality).toBe("friendly");

		rmSync(root, { recursive: true, force: true });
	});
});
