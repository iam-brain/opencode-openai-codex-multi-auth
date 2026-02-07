import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const originalXdg = process.env.XDG_CONFIG_HOME;

function maybeReleaseTagResponse(url: string): Response | null {
	if (!url.includes("api.github.com/repos/openai/codex/releases/latest")) {
		return null;
	}
	return new Response(JSON.stringify({ tag_name: "rust-v9.8.7" }), {
		status: 200,
	});
}

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
		let capturedUrl = "";

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				capturedUrl = url;
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								base_instructions: "Server base instructions",
								apply_patch_tool_type: "freeform",
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
		expect(capturedUrl).toContain("/codex/models");
		expect(defaults.onlineDefaultPersonality).toBeUndefined();
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from server");
		expect(defaults.baseInstructions).toBe("Server base instructions");
		expect(defaults.applyPatchToolType).toBe("freeform");

		rmSync(root, { recursive: true, force: true });
	});

	it("reads personalities map from instructions_variables", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-map-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								model_messages: {
									instructions_template: "Base {{ personality }}",
									instructions_variables: {
										personalities: {
											default: "",
											friendly: "Friendly from map",
											pragmatic: "Pragmatic from map",
										},
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

		expect(defaults.personalityMessages?.friendly).toBe("Friendly from map");
		expect(defaults.personalityMessages?.pragmatic).toBe("Pragmatic from map");
		rmSync(root, { recursive: true, force: true });
	});

	it("uses codex release semver for client_version", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-client-version-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();
		let capturedUrl = "";

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.8.7" }), {
					status: 200,
				});
			}
			if (url.includes("/codex/models")) {
				capturedUrl = url;
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

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(capturedUrl).toContain("client_version=9.8.7");
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to cached client_version when release lookup fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-client-version-cache-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();
		let capturedUrl = "";

		const cacheDir = dirname(__internal.MODELS_CACHE_FILE);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.CLIENT_VERSION_CACHE_FILE,
			JSON.stringify({ version: "2.3.4", fetchedAt: Date.now() - 1000 }),
			"utf8",
		);

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				throw new Error("offline");
			}
			if (url.includes("/codex/models")) {
				capturedUrl = url;
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

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(capturedUrl).toContain("client_version=2.3.4");
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
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
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

	it("refreshes stale cache with ETag and uses cached models on 304", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-online-first-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();
		const cacheDir = dirname(__internal.MODELS_CACHE_FILE);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.MODELS_CACHE_FILE,
			JSON.stringify({
				fetchedAt: 0,
				source: "server",
				etag: '"etag-123"',
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
			"utf8",
		);

		const refreshFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				const headers = init?.headers as Record<string, string> | undefined;
				expect(headers?.["If-None-Match"]).toBe('"etag-123"');
				return new Response(null, { status: 304, headers: { etag: '"etag-123"' } });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: refreshFetch as unknown as typeof fetch,
		});

		expect(refreshFetch).toHaveBeenCalled();
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from stale cache");
		rmSync(root, { recursive: true, force: true });
	});

	it("warms model catalog into memory from cache", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-warm-cache-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, warmCodexModelCatalog, getCodexModelRuntimeDefaults } = await loadModule();

		const cacheDir = dirname(__internal.MODELS_CACHE_FILE);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.MODELS_CACHE_FILE,
			JSON.stringify({
				fetchedAt: Date.now(),
				source: "server",
				etag: '"warm-etag"',
				models: [
					{
						slug: "gpt-5.3-codex",
						model_messages: {
							instructions_template: "Base {{ personality }}",
							instructions_variables: {
								personality_default: "",
								personality_friendly: "Friendly from warm cache",
								personality_pragmatic: "Pragmatic from warm cache",
							},
						},
					},
				],
			}),
			"utf8",
		);

		const mockFetch = vi.fn(async () => {
			throw new Error("unexpected fetch");
		});

		await warmCodexModelCatalog();
		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		expect(mockFetch).not.toHaveBeenCalled();
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from warm cache");
		rmSync(root, { recursive: true, force: true });
	});

	it("reuses in-memory catalog for repeated calls", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-memoized-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
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
										personality_friendly: "Friendly from first fetch",
										personality_pragmatic: "Pragmatic from first fetch",
									},
								},
							},
						],
					}),
					{ status: 200, headers: { etag: '"fresh"' } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});
		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		const serverCalls = mockFetch.mock.calls.filter((call) =>
			call[0]?.toString().includes("/codex/models"),
		).length;
		expect(serverCalls).toBe(1);
		expect(defaults.personalityMessages?.friendly).toBe("Friendly from first fetch");
		rmSync(root, { recursive: true, force: true });
	});

	it("avoids repeated server fetches when stale cache exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-stale-retry-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		const cacheDir = dirname(__internal.MODELS_CACHE_FILE);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.MODELS_CACHE_FILE,
			JSON.stringify({
				fetchedAt: 0,
				source: "server",
				etag: "etag-stale",
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
			"utf8",
		);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				throw new Error("offline");
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		const serverCalls = fetchMock.mock.calls.filter((call) =>
			call[0]?.toString().includes("/codex/models"),
		).length;
		expect(serverCalls).toBe(1);
		rmSync(root, { recursive: true, force: true });
	});

	it("allows authenticated refresh after unauthenticated failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-auth-guard-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		const cacheDir = dirname(__internal.MODELS_CACHE_FILE);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.MODELS_CACHE_FILE,
			JSON.stringify({
				fetchedAt: 0,
				source: "server",
				etag: "etag-stale",
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
			"utf8",
		);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				throw new Error("offline");
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		const serverCalls = fetchMock.mock.calls.filter((call) =>
			call[0]?.toString().includes("/codex/models"),
		).length;
		expect(serverCalls).toBe(2);
		rmSync(root, { recursive: true, force: true });
	});

	it("retries server fetch after short backoff", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "codex-models-backoff-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		const cacheDir = dirname(__internal.MODELS_CACHE_FILE);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.MODELS_CACHE_FILE,
			JSON.stringify({
				fetchedAt: 0,
				source: "server",
				etag: "etag-stale",
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
			"utf8",
		);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				throw new Error("offline");
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const start = new Date("2026-02-06T00:00:00.000Z");
		vi.setSystemTime(start);

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		vi.setSystemTime(new Date(start.getTime() + 2 * 60 * 1000));
		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		const serverCalls = fetchMock.mock.calls.filter((call) =>
			call[0]?.toString().includes("/codex/models"),
		).length;
		expect(serverCalls).toBe(2);
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("suppresses repeated server fetches without cache during backoff", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-backoff-nocache-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		let serverCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				serverCalls += 1;
				throw new Error("offline");
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/")) {
				throw new Error("github offline");
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		expect(serverCalls).toBe(1);
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
		expect(__internal.readStaticTemplateDefaults(moduleDir)).toBe(defaults);

		rmSync(root, { recursive: true, force: true });
	});
});
