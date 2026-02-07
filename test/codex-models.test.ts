import { afterEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

	it("seeds friendly/pragmatic personality cache from server data", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
									instructions_variables: {
										personality_friendly: "Friendly from server",
										personality_pragmatic: "Pragmatic from server",
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

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		const personalityDir = join(root, "opencode", "Personalities");
		const friendly = readFileSync(join(personalityDir, "Friendly.md"), "utf8");
		const pragmatic = readFileSync(join(personalityDir, "Pragmatic.md"), "utf8");
		expect(friendly).toContain("Friendly from server");
		expect(pragmatic).toContain("Pragmatic from server");

		rmSync(root, { recursive: true, force: true });
	});

	it("does not overwrite personality cache when using static defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-static-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const personalityDir = join(root, "opencode", "Personalities");
		mkdirSync(personalityDir, { recursive: true });
		writeFileSync(join(personalityDir, "Friendly.md"), "Old friendly", "utf8");
		writeFileSync(
			join(personalityDir, "Pragmatic.md"),
			"Old pragmatic",
			"utf8",
		);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				throw new Error("offline");
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/")) {
				throw new Error("github offline");
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.3-codex", {
				accessToken: "token",
				accountId: "account",
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");

		expect(readFileSync(join(personalityDir, "Friendly.md"), "utf8")).toBe(
			"Old friendly",
		);
		expect(readFileSync(join(personalityDir, "Pragmatic.md"), "utf8")).toBe(
			"Old pragmatic",
		);

		rmSync(root, { recursive: true, force: true });
	});

	it("does not overwrite user-managed personality files", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-user-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const personalityDir = join(root, "opencode", "Personalities");
		mkdirSync(personalityDir, { recursive: true });
		writeFileSync(join(personalityDir, "Friendly.md"), "User friendly", "utf8");
		writeFileSync(
			join(personalityDir, "Pragmatic.md"),
			"User pragmatic",
			"utf8",
		);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
									instructions_variables: {
										personality_friendly: "Friendly from server",
										personality_pragmatic: "Pragmatic from server",
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

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		expect(readFileSync(join(personalityDir, "Friendly.md"), "utf8")).toBe(
			"User friendly",
		);
		expect(readFileSync(join(personalityDir, "Pragmatic.md"), "utf8")).toBe(
			"User pragmatic",
		);

		rmSync(root, { recursive: true, force: true });
	});

	it("does not seed personalities from GitHub-sourced cache", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-github-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		mkdirSync(dirname(__internal.getModelsCacheFile("account")), { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile("account"),
			JSON.stringify({
				fetchedAt: Date.now(),
				source: "github",
				models: [
					{
						slug: "gpt-5.3-codex",
						model_messages: {
							instructions_variables: {
								personality_friendly: "Friendly from github",
								personality_pragmatic: "Pragmatic from github",
							},
						},
					},
				],
			}),
			"utf8",
		);

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.3-codex", {
				accountId: "account",
			}),
		).rejects.toThrow("Model catalog unavailable");

		const personalityDir = join(root, "opencode", "Personalities");
		expect(existsSync(personalityDir)).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});

	it("seeds personalities from legacy cache without source", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-legacy-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		mkdirSync(dirname(__internal.getModelsCacheFile("account")), { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile("account"),
			JSON.stringify({
				fetchedAt: Date.now(),
				models: [
					{
						slug: "gpt-5.3-codex",
						model_messages: {
							instructions_variables: {
								personality_friendly: "Friendly from legacy cache",
								personality_pragmatic: "Pragmatic from legacy cache",
							},
						},
					},
				],
			}),
			"utf8",
		);

		await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accountId: "account",
		});

		const personalityDir = join(root, "opencode", "Personalities");
		const friendly = readFileSync(join(personalityDir, "Friendly.md"), "utf8");
		const pragmatic = readFileSync(join(personalityDir, "Pragmatic.md"), "utf8");
		expect(friendly).toContain("Friendly from legacy cache");
		expect(pragmatic).toContain("Pragmatic from legacy cache");

		rmSync(root, { recursive: true, force: true });
	});

	it("warns on personality cache write failures but returns defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-personality-warn-"));
		const previousLogging = process.env.ENABLE_PLUGIN_REQUEST_LOGGING;
		process.env.ENABLE_PLUGIN_REQUEST_LOGGING = "1";
		process.env.XDG_CONFIG_HOME = root;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { getCodexModelRuntimeDefaults } = await loadModule();
			const personalityDir = join(root, "opencode", "Personalities");
			mkdirSync(join(root, "opencode"), { recursive: true });
			writeFileSync(personalityDir, "not-a-directory", "utf8");

			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
										instructions_variables: {
											personality_friendly: "Friendly from server",
											personality_pragmatic: "Pragmatic from server",
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
				fetchImpl: fetchMock as unknown as typeof fetch,
			});

			expect(defaults.personalityMessages?.friendly).toBe(
				"Friendly from server",
			);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			if (previousLogging === undefined) {
				delete process.env.ENABLE_PLUGIN_REQUEST_LOGGING;
			} else {
				process.env.ENABLE_PLUGIN_REQUEST_LOGGING = previousLogging;
			}
			warnSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
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

		const cacheDir = dirname(__internal.getModelsCacheFile("account"));
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
		// Use account-scoped cache file
		const accountId = "account";
		const cacheDir = dirname(__internal.getModelsCacheFile(accountId));
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile(accountId),
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
			accountId: accountId,
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

		// Seed per-account cache
		const cacheDir = dirname(__internal.getModelsCacheFile("account"));
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile("account"),
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

		// Warm per-account cache
		await warmCodexModelCatalog({ accountId: "account" });
		
		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
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

		const cacheDir = dirname(__internal.getModelsCacheFile("account"));
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile("account"),
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

		const cacheDir = dirname(__internal.getModelsCacheFile("account"));
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile("account"),
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
		expect(serverCalls).toBe(2);
		rmSync(root, { recursive: true, force: true });
	});

	it("retries server fetch after short backoff", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "codex-models-backoff-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		const cacheDir = dirname(__internal.getModelsCacheFile("account"));
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			__internal.getModelsCacheFile("account"),
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

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.3-codex", {
				accessToken: "token",
				accountId: "account",
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");
		await expect(
			getCodexModelRuntimeDefaults("gpt-5.3-codex", {
				accessToken: "token",
				accountId: "account",
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");

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

	it("rejects models missing from the server catalog", async () => {
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

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.4-codex", {
				accessToken: "token",
				accountId: "account",
				fetchImpl: mockFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow('Unknown model "gpt-5.4-codex"');
		await expect(
			getCodexModelRuntimeDefaults("gpt-5.4-codex", {
				accessToken: "token",
				accountId: "account",
				fetchImpl: mockFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow("Available models: gpt-5.3-codex");
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects when server catalog is unavailable", async () => {
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

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.4-codex", {
				fetchImpl: mockFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects when server catalog is unavailable (no GitHub fallback)", async () => {
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

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.4-codex", {
				fetchImpl: mockFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");
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

	it("rejects when server catalog and cache are unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-static-fallback-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();

		const failingFetch = vi.fn(async () => {
			throw new Error("offline");
		});

		await expect(
			getCodexModelRuntimeDefaults("gpt-5.9-codex", {
				fetchImpl: failingFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");
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

	it("applies backoff guard even on cold start with no cache", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-backoff-coldstart-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults } = await loadModule();
		let serverCallCount = 0;

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				serverCallCount++;
				throw new Error("Server unavailable");
			}
			if (url.includes("github.com")) {
				throw new Error("GitHub also down");
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		// First call - should attempt server and fail
		await expect(
			getCodexModelRuntimeDefaults("gpt-5.3-codex", {
				accessToken: "token",
				accountId: "account1",
				fetchImpl: mockFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");
		expect(serverCallCount).toBe(1);

		// Second call - should be gated by backoff (no server call)
		await expect(
			getCodexModelRuntimeDefaults("gpt-5.3-codex", {
				accessToken: "token",
				accountId: "account1",
				fetchImpl: mockFetch as unknown as typeof fetch,
			}),
		).rejects.toThrow("Model catalog unavailable");
		expect(serverCallCount).toBe(1); // Still 1 - backoff prevented call

		rmSync(root, { recursive: true, force: true });
	});

	it("scopes model cache by account identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-account-scope-"));
		process.env.XDG_CONFIG_HOME = root;
		const { getCodexModelRuntimeDefaults, __internal } = await loadModule();

		// Account 1 gets one set of models
		const mockFetchAccount1 = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								base_instructions: "Account1 instructions",
							},
						],
					}),
					{ status: 200, headers: { etag: '"acc1"' } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		// Account 2 gets different models (e.g., pro tier)
		const mockFetchAccount2 = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								base_instructions: "Account2 PRO instructions",
							},
							{
								slug: "gpt-5.2-pro",
								base_instructions: "Pro-only model",
							},
						],
					}),
					{ status: 200, headers: { etag: '"acc2"' } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		// Fetch for account1
		const defaults1 = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token1",
			accountId: "account1",
			fetchImpl: mockFetchAccount1 as unknown as typeof fetch,
			forceRefresh: true,
		});
		expect(defaults1.baseInstructions).toBe("Account1 instructions");

		// Fetch for account2 (should get different cache)
		const defaults2 = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token2",
			accountId: "account2",
			fetchImpl: mockFetchAccount2 as unknown as typeof fetch,
			forceRefresh: true,
		});
		expect(defaults2.baseInstructions).toBe("Account2 PRO instructions");

		// Verify cache files are separate
		const cacheFile1 = __internal.getModelsCacheFile("account1");
		const cacheFile2 = __internal.getModelsCacheFile("account2");
		const hash1 = __internal.hashAccountId("account1");
		const hash2 = __internal.hashAccountId("account2");
		expect(cacheFile1).not.toBe(cacheFile2);
		expect(hash1).not.toBe(hash2);
		expect(cacheFile1).toContain(hash1);
		expect(cacheFile2).toContain(hash2);
		expect(cacheFile1).not.toContain("account1");
		expect(cacheFile2).not.toContain("account2");

		rmSync(root, { recursive: true, force: true });
	});

	it("scopes cached variant efforts by account", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-efforts-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCachedVariantEfforts } = await loadModule();

		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });

		const account1Cache = {
			fetchedAt: Date.now(),
			source: "server",
			models: [
				{
					slug: "gpt-5.3-codex",
					supported_reasoning_levels: [{ effort: "high" }, { effort: "medium" }],
				},
			],
		};
		const account2Cache = {
			fetchedAt: Date.now(),
			source: "server",
			models: [
				{
					slug: "gpt-5.2-codex",
					supported_reasoning_levels: [{ effort: "low" }],
				},
			],
		};

		writeFileSync(
			__internal.getModelsCacheFile("account1"),
			JSON.stringify(account1Cache),
			"utf8",
		);
		writeFileSync(
			__internal.getModelsCacheFile("account2"),
			JSON.stringify(account2Cache),
			"utf8",
		);

		const efforts1 = getCachedVariantEfforts("account1");
		const efforts2 = getCachedVariantEfforts("account2");

		expect(efforts1.get("gpt-5.3-codex")).toEqual(["high", "medium"]);
		expect(efforts2.get("gpt-5.2-codex")).toEqual(["low"]);

		rmSync(root, { recursive: true, force: true });
	});

	it("applies session TTL hard limit to in-memory cache", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-models-session-ttl-"));
		process.env.XDG_CONFIG_HOME = root;
		
		// Create stale cache on disk (older than session max age)
		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });
		const staleCache = {
			fetchedAt: Date.now() - (61 * 60 * 1000), // 61 minutes ago (past 1hr limit)
			source: "server",
			models: [{ slug: "gpt-5.3-codex", base_instructions: "Stale instructions" }],
			etag: '"stale"',
		};
		writeFileSync(
			join(cacheDir, "codex-models-cache.json"),
			JSON.stringify(staleCache),
			"utf8",
		);

		const { getCodexModelRuntimeDefaults } = await loadModule();
		let serverCalled = false;

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				serverCalled = true;
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								base_instructions: "Fresh instructions",
							},
						],
					}),
					{ status: 200, headers: { etag: '"fresh"' } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		// Should have fetched fresh data (cache was beyond session TTL)
		expect(serverCalled).toBe(true);
		expect(defaults.baseInstructions).toBe("Fresh instructions");

		rmSync(root, { recursive: true, force: true });
	});

	it("evicts stale in-memory cache and reuses fresh disk cache", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "codex-models-session-evict-"));
		process.env.XDG_CONFIG_HOME = root;
		const { __internal, getCodexModelRuntimeDefaults } = await loadModule();

		const cacheDir = dirname(__internal.getModelsCacheFile("account"));
		mkdirSync(cacheDir, { recursive: true });

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			const release = maybeReleaseTagResponse(url);
			if (release) return release;
			if (url.includes("/codex/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex",
								base_instructions: "Memory instructions",
							},
						],
					}),
					{ status: 200, headers: { etag: '"mem"' } },
				);
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
		const initialServerCalls = fetchMock.mock.calls.filter((call) =>
			call[0]?.toString().includes("/codex/models"),
		).length;
		expect(initialServerCalls).toBe(1);

		const expired = new Date(start.getTime() + 61 * 60 * 1000);
		vi.setSystemTime(expired);
		writeFileSync(
			__internal.getModelsCacheFile("account"),
			JSON.stringify({
				fetchedAt: Date.now(),
				source: "server",
				etag: '"disk"',
				models: [
					{
						slug: "gpt-5.3-codex",
						base_instructions: "Disk instructions",
					},
				],
			}),
			"utf8",
		);

		const defaults = await getCodexModelRuntimeDefaults("gpt-5.3-codex", {
			accessToken: "token",
			accountId: "account",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(defaults.baseInstructions).toBe("Disk instructions");
		const finalServerCalls = fetchMock.mock.calls.filter((call) =>
			call[0]?.toString().includes("/codex/models"),
		).length;
		expect(finalServerCalls).toBe(1);

		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});
});
