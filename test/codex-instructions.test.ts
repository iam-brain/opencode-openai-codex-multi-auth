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
import { join } from "node:path";

const originalXdg = process.env.XDG_CONFIG_HOME;

async function loadModule() {
	vi.resetModules();
	return import("../lib/prompts/codex.js");
}

describe("codex instructions cache", () => {
	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("warms instructions cache on startup and reuses in-session", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-instructions-warm-"));
		process.env.XDG_CONFIG_HOME = root;
		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });

		const cacheFile = join(cacheDir, "codex-instructions.md");
		const metaFile = join(cacheDir, "codex-instructions-meta.json");
		const cachedValue = "cached instructions";
		writeFileSync(cacheFile, cachedValue, "utf8");
		writeFileSync(
			metaFile,
			JSON.stringify({
				etag: null,
				tag: "rust-v1.0.0",
				lastChecked: Date.now(),
				url: "https://example.test",
			}),
			"utf8",
		);

		const fetchSpy = vi.fn(async () => {
			throw new Error("network");
		});
		vi.stubGlobal("fetch", fetchSpy);

		const { warmCodexInstructions, getCodexInstructions } = await loadModule();

		await warmCodexInstructions();

		expect(fetchSpy).not.toHaveBeenCalled();

		const first = await getCodexInstructions("codex");
		expect(first).toBe(cachedValue);

		writeFileSync(cacheFile, "tampered", "utf8");

		const second = await getCodexInstructions("codex");
		expect(second).toBe(cachedValue);

		rmSync(root, { recursive: true, force: true });
	});

	it("refreshes stale cache on warm and overwrites cache atomically", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-instructions-stale-"));
		process.env.XDG_CONFIG_HOME = root;
		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });

		const cacheFile = join(cacheDir, "codex-instructions.md");
		const metaFile = join(cacheDir, "codex-instructions-meta.json");
		const staleChecked = Date.now() - 16 * 60 * 1000;
		writeFileSync(cacheFile, "stale instructions", "utf8");
		writeFileSync(
			metaFile,
			JSON.stringify({
				etag: '"old"',
				tag: "rust-v1.0.0",
				lastChecked: staleChecked,
				url: "https://example.test",
			}),
			"utf8",
		);

		const newInstructions = "fresh instructions";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.9.9" }), {
					status: 200,
				});
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/rust-v9.9.9")) {
				return new Response(newInstructions, {
					status: 200,
					headers: { etag: '"next"' },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { warmCodexInstructions, getCodexInstructions } = await loadModule();

		await warmCodexInstructions();

		expect(fetchMock).toHaveBeenCalled();
		expect(readFileSync(cacheFile, "utf8")).toBe(newInstructions);
		const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
			tag?: string;
			etag?: string;
			lastChecked?: number;
		};
		expect(meta.tag).toBe("rust-v9.9.9");
		expect(meta.etag).toBe('"next"');
		expect(meta.lastChecked).toBeGreaterThan(staleChecked);

		const warmed = await getCodexInstructions("codex");
		expect(warmed).toBe(newInstructions);

		rmSync(root, { recursive: true, force: true });
	});

	it("re-fetches when GitHub returns 304 but cache file is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-instructions-304-missing-"));
		process.env.XDG_CONFIG_HOME = root;
		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });

		const cacheFile = join(cacheDir, "codex-instructions.md");
		const metaFile = join(cacheDir, "codex-instructions-meta.json");
		const staleChecked = Date.now() - 16 * 60 * 1000;
		writeFileSync(
			metaFile,
			JSON.stringify({
				etag: '"stale"',
				tag: "rust-v9.9.9",
				lastChecked: staleChecked,
				url: "https://example.test",
			}),
			"utf8",
		);

		const newInstructions = "fresh instructions after refetch";
		let rawFetchCount = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.9.9" }), {
					status: 200,
				});
			}
		if (url.includes("raw.githubusercontent.com/openai/codex/rust-v9.9.9")) {
			rawFetchCount += 1;
			if (rawFetchCount === 1) {
				return {
					status: 304,
					ok: false,
					text: async () => "",
					headers: new Headers(),
				} as Response;
			}
			return new Response(newInstructions, {
				status: 200,
				headers: { etag: '"next"' },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { getCodexInstructions } = await loadModule();
		const instructions = await getCodexInstructions("codex");

		expect(instructions).toBe(newInstructions);
		expect(rawFetchCount).toBe(2);
		expect(readFileSync(cacheFile, "utf8")).toBe(newInstructions);
		const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
			tag?: string;
			etag?: string;
			lastChecked?: number;
		};
		expect(meta.tag).toBe("rust-v9.9.9");
		expect(meta.etag).toBe('"next"');
		expect(meta.lastChecked).toBeGreaterThan(staleChecked);

		rmSync(root, { recursive: true, force: true });
	});

	it("reuses cache family based on resolved prompt file", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-instructions-family-"));
		process.env.XDG_CONFIG_HOME = root;
		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.9.9" }), {
					status: 200,
				});
			}
			if (url.includes("api.github.com/repos/openai/codex/contents/")) {
				return new Response(JSON.stringify([]), { status: 200 });
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/rust-v9.9.9")) {
				if (url.includes("gpt-5.2-codex_prompt.md")) {
					return new Response("prompt for gpt-5.2", {
						status: 200,
						headers: { etag: '"etag"' },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { getCodexInstructions } = await loadModule();
		const instructions = await getCodexInstructions("gpt-5.3-codex");
		expect(instructions).toContain("prompt for gpt-5.2");

		const gpt52Cache = join(cacheDir, "gpt-5.2-codex-instructions.md");
		const gpt52Meta = join(cacheDir, "gpt-5.2-codex-instructions-meta.json");
		const gpt53Cache = join(cacheDir, "gpt-5.3-codex-instructions.md");
		const gpt53Meta = join(cacheDir, "gpt-5.3-codex-instructions-meta.json");

		expect(existsSync(gpt52Cache)).toBe(true);
		expect(existsSync(gpt52Meta)).toBe(true);
		expect(existsSync(gpt53Cache)).toBe(false);
		expect(existsSync(gpt53Meta)).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});

	it("removes instruction caches when prompt files are missing in GitHub", async () => {
		const root = mkdtempSync(join(tmpdir(), "codex-instructions-prune-"));
		process.env.XDG_CONFIG_HOME = root;
		const cacheDir = join(root, "opencode", "cache");
		mkdirSync(cacheDir, { recursive: true });

		const staleCache = join(cacheDir, "gpt-5.3-codex-instructions.md");
		const staleMeta = join(cacheDir, "gpt-5.3-codex-instructions-meta.json");
		writeFileSync(staleCache, "stale", "utf8");
		writeFileSync(
			staleMeta,
			JSON.stringify({
				tag: "rust-v1.0.0",
				etag: null,
				lastChecked: Date.now(),
				url: "https://example.test",
			}),
			"utf8",
		);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v9.9.9" }), {
					status: 200,
				});
			}
			if (url.includes("api.github.com/repos/openai/codex/contents/")) {
				return new Response(
					JSON.stringify([
						{ name: "gpt-5.2-codex_prompt.md", type: "file" },
						{ name: "gpt_5_1_prompt.md", type: "file" },
					]),
					{ status: 200 },
				);
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/rust-v9.9.9")) {
				return new Response("prompt", { status: 200, headers: { etag: '"etag"' } });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { getCodexInstructions } = await loadModule();
		await getCodexInstructions("gpt-5.3-codex");

		expect(existsSync(staleCache)).toBe(false);
		expect(existsSync(staleMeta)).toBe(false);

		rmSync(root, { recursive: true, force: true });
	});
});
