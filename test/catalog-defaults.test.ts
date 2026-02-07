import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildInternalModelDefaults,
	mergeModelDefaults,
} from "../lib/catalog-defaults.js";

describe("catalog internal defaults", () => {
	const originalXdg = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
	});

	it("adds catalog models using template defaults", () => {
		const root = mkdtempSync(join(tmpdir(), "catalog-defaults-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const cacheDir = join(root, "opencode", "cache");
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(
				join(cacheDir, "codex-models-cache.json"),
				JSON.stringify({
					fetchedAt: Date.now(),
					source: "server",
					models: [{ slug: "gpt-5.3-codex" }],
				}),
				"utf8",
			);

			const defaults = buildInternalModelDefaults();

			expect(defaults["gpt-5.3-codex"]).toBeDefined();
			expect(defaults["gpt-5.3-codex"].name).toBe(
				"GPT 5.3 Codex (OAuth)",
			);
			expect(defaults["gpt-5.3-codex"].limit?.context).toBe(
				defaults["gpt-5.2-codex"].limit?.context,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses gpt-5.3-codex as template for unknown codex models", () => {
		const root = mkdtempSync(join(tmpdir(), "catalog-defaults-unknown-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const cacheDir = join(root, "opencode", "cache");
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(
				join(cacheDir, "codex-models-cache.json"),
				JSON.stringify({
					fetchedAt: Date.now(),
					source: "server",
					models: [{ slug: "gpt-5.9-codex" }],
				}),
				"utf8",
			);

			const defaults = buildInternalModelDefaults();

			expect(defaults["gpt-5.9-codex"]).toBeDefined();
			expect(defaults["gpt-5.9-codex"].name).toBe(
				"GPT 5.9 Codex (OAuth)",
			);
			// Should have variants from gpt-5.3-codex, not gpt-5.2-codex
			// (They are currently identical in opencode-modern.json, but 5.3 is the better template)
			expect(defaults["gpt-5.9-codex"].limit?.context).toBe(
				defaults["gpt-5.3-codex"].limit?.context,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("overrides template defaults with live metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "catalog-defaults-live-"));
		process.env.XDG_CONFIG_HOME = root;
		try {
			const cacheDir = join(root, "opencode", "cache");
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(
				join(cacheDir, "codex-models-cache.json"),
				JSON.stringify({
					fetchedAt: Date.now(),
					source: "server",
					models: [
						{
							slug: "gpt-5.3-codex",
							display_name: "Codex 5.3",
							context_window: 123456,
							truncation_policy: {
								mode: "tokens",
								limit: 4242,
							},
							input_modalities: ["text"],
						},
					],
				}),
				"utf8",
			);

			const defaults = buildInternalModelDefaults();

			expect(defaults["gpt-5.3-codex"].name).toBe("Codex 5.3");
			expect(defaults["gpt-5.3-codex"].limit?.context).toBe(123456);
			expect(defaults["gpt-5.3-codex"].limit?.output).toBe(4242);
			expect(defaults["gpt-5.3-codex"].modalities?.input).toEqual(["text"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("merges config overrides above internal defaults", () => {
		const defaults = {
			"gpt-5.2-codex": { name: "Default" },
			"gpt-5.1": { name: "Default 5.1" },
		};
		const overrides = {
			"gpt-5.2-codex": { name: "Custom" },
			"custom-model": { name: "Custom" },
		};

		const merged = mergeModelDefaults(overrides, defaults);

		expect(merged["gpt-5.2-codex"].name).toBe("Custom");
		expect(merged["gpt-5.1"].name).toBe("Default 5.1");
		expect(merged["custom-model"].name).toBe("Custom");
	});
});
