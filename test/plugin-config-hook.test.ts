import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("OpenAIAuthPlugin config hook", () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
  });

  it("registers gpt-5.3-codex variants on base model metadata and filters non-allowlisted models", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-config-hook-"));
    process.env.XDG_CONFIG_HOME = root;

    try {
      vi.resetModules();
      const { OpenAIAuthPlugin: FreshPlugin } = await import("../index.js");
      const { getCachedVariantEfforts } =
        await import("../lib/prompts/codex-models.js");
      const plugin = await FreshPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.3-codex": {
                id: "gpt-5.3-codex",
                instructions: "TEMPLATE",
              },
              "o3-mini": {
                id: "o3-mini",
                instructions: "OTHER",
              },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(cfg.provider.openai.models["gpt-5.3-codex"]).toBeDefined();
      expect(cfg.provider.openai.models["gpt-5.3-codex"].instructions).toBe(
        "TEMPLATE",
      );
      expect(cfg.provider.openai.models["gpt-5.3-codex"].id).toBe(
        "gpt-5.3-codex",
      );
      expect(cfg.provider.openai.models["gpt-5.3-codex-low"]).toBeUndefined();
      expect(
        cfg.provider.openai.models["gpt-5.3-codex-medium"],
      ).toBeUndefined();
      expect(cfg.provider.openai.models["gpt-5.3-codex-high"]).toBeUndefined();
      expect(cfg.provider.openai.models["gpt-5.3-codex-xhigh"]).toBeUndefined();
      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants.low,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants.medium,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants.high,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants.xhigh,
      ).toBeDefined();
      expect(cfg.provider.openai.models["o3-mini"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers gpt-5.3-codex when gpt-5.3-codex metadata has no instructions field", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-config-hook-noinst-"));
    process.env.XDG_CONFIG_HOME = root;

    try {
      vi.resetModules();
      const { OpenAIAuthPlugin: FreshPlugin } = await import("../index.js");
      const { getCachedVariantEfforts } =
        await import("../lib/prompts/codex-models.js");
      const plugin = await FreshPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.3-codex": {
                name: "GPT 5.3 Codex (Codex)",
              },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(cfg.provider.openai.models["gpt-5.3-codex"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not synthesize gpt-5.3-codex from gpt-5.2-codex in config hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-config-hook-no52clone-"));
    process.env.XDG_CONFIG_HOME = root;

    try {
      vi.resetModules();
      const { OpenAIAuthPlugin: FreshPlugin } = await import("../index.js");
      const { getCachedVariantEfforts } =
        await import("../lib/prompts/codex-models.js");
      const plugin = await FreshPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.2-codex": {
                id: "gpt-5.2-codex",
                instructions: "TEMPLATE_52",
              },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(cfg.provider.openai.models["gpt-5.3-codex"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves effort-suffixed models when base entry is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-config-hook-legacy-"));
    process.env.XDG_CONFIG_HOME = root;

    try {
      vi.resetModules();
      const { OpenAIAuthPlugin: FreshPlugin } = await import("../index.js");
      const plugin = await FreshPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.3-codex-low": { id: "gpt-5.3-codex-low" },
              "gpt-5.3-codex-high": { id: "gpt-5.3-codex-high" },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(cfg.provider.openai.models["gpt-5.3-codex-low"]).toBeDefined();
      expect(cfg.provider.openai.models["gpt-5.3-codex-high"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses cached supported_reasoning_levels for codex variants", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-config-hook-cache-"));
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
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "medium" },
              ],
            },
          ],
        }),
        "utf8",
      );

      vi.resetModules();
      const { OpenAIAuthPlugin: FreshPlugin } = await import("../index.js");
      const { getCachedVariantEfforts } =
        await import("../lib/prompts/codex-models.js");
      const plugin = await FreshPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.3-codex": { id: "gpt-5.3-codex" },
            },
          },
        },
        experimental: {},
      };

      const efforts = getCachedVariantEfforts();
      expect(efforts.get("gpt-5.3-codex")).toEqual(["low", "medium"]);

      await (plugin as any).config(cfg);

      const variants = cfg.provider.openai.models["gpt-5.3-codex"].variants;
      expect(Object.keys(variants)).toEqual(["low", "medium"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports future gpt codex models without hardcoded allowlist updates", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "opencode-config-hook-future-codex-"),
    );
    process.env.XDG_CONFIG_HOME = root;

    try {
      const plugin = await OpenAIAuthPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.4-codex": {
                id: "gpt-5.4-codex",
                instructions: "FUTURE_TEMPLATE",
              },
              "o3-mini": {
                id: "o3-mini",
                instructions: "OTHER",
              },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(cfg.provider.openai.models["gpt-5.4-codex"]).toBeDefined();
      expect(cfg.provider.openai.models["gpt-5.4-codex"].instructions).toBe(
        "FUTURE_TEMPLATE",
      );
      expect(cfg.provider.openai.models["gpt-5.4-codex-low"]).toBeUndefined();
      expect(
        cfg.provider.openai.models["gpt-5.4-codex-medium"],
      ).toBeUndefined();
      expect(cfg.provider.openai.models["gpt-5.4-codex-high"]).toBeUndefined();
      expect(cfg.provider.openai.models["gpt-5.4-codex-xhigh"]).toBeUndefined();
      expect(
        cfg.provider.openai.models["gpt-5.4-codex"].variants,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.4-codex"].variants.low,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.4-codex"].variants.medium,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.4-codex"].variants.high,
      ).toBeDefined();
      expect(
        cfg.provider.openai.models["gpt-5.4-codex"].variants.xhigh,
      ).toBeDefined();
      expect(cfg.provider.openai.models["o3-mini"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves suffixed variant metadata when folding into base model variants", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "opencode-config-hook-variant-merge-"),
    );
    process.env.XDG_CONFIG_HOME = root;

    try {
      const plugin = await OpenAIAuthPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.3-codex": {
                id: "gpt-5.3-codex",
                name: "GPT 5.3 Codex",
                variants: {
                  low: {
                    reasoningEffort: "low",
                    textVerbosity: "low",
                  },
                },
              },
              "gpt-5.3-codex-high": {
                id: "gpt-5.3-codex-high",
                name: "GPT 5.3 Codex High",
                textVerbosity: "high",
                reasoningSummary: "detailed",
                disabled: true,
              },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(cfg.provider.openai.models["gpt-5.3-codex-high"]).toBeUndefined();
      expect(cfg.provider.openai.models["gpt-5.3-codex"]).toBeDefined();
      expect(cfg.provider.openai.models["gpt-5.3-codex"].variants.low).toEqual({
        reasoningEffort: "low",
        textVerbosity: "low",
      });
      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants.high,
      ).toMatchObject({
        reasoningEffort: "high",
        textVerbosity: "medium",
        reasoningSummary: "detailed",
        disabled: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers existing base variant values over suffixed metadata on key conflicts", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "opencode-config-hook-variant-precedence-"),
    );
    process.env.XDG_CONFIG_HOME = root;

    try {
      const plugin = await OpenAIAuthPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

      const cfg: any = {
        provider: {
          openai: {
            models: {
              "gpt-5.3-codex": {
                id: "gpt-5.3-codex",
                variants: {
                  high: {
                    reasoningEffort: "high",
                    textVerbosity: "medium",
                    reasoningSummary: "concise",
                  },
                },
              },
              "gpt-5.3-codex-high": {
                id: "gpt-5.3-codex-high",
                textVerbosity: "high",
                reasoningSummary: "detailed",
              },
            },
          },
        },
        experimental: {},
      };

      await (plugin as any).config(cfg);

      expect(
        cfg.provider.openai.models["gpt-5.3-codex"].variants.high,
      ).toMatchObject({
        reasoningEffort: "high",
        textVerbosity: "medium",
        reasoningSummary: "concise",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not register codex commands", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "opencode-config-hook-codex-auth-"),
    );
    process.env.XDG_CONFIG_HOME = root;

    try {
      const plugin = await OpenAIAuthPlugin({
        client: {
          tui: { showToast: vi.fn() },
          auth: { set: vi.fn() },
        } as any,
      } as any);

		const cfg: any = { provider: { openai: {} }, experimental: {} };
		await (plugin as any).config(cfg);

		const commandKeys = Object.keys(cfg.command ?? {});
		expect(commandKeys.some((key) => key.startsWith("codex-"))).toBe(false);
		const toolKeys = cfg.experimental?.primary_tools ?? [];
		expect(toolKeys.some((key: string) => key.startsWith("codex-"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	});

	it("preserves user-defined codex-prefixed commands and tools", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "opencode-config-hook-codex-custom-"),
		);
		process.env.XDG_CONFIG_HOME = root;

		try {
			const plugin = await OpenAIAuthPlugin({
				client: {
					tui: { showToast: vi.fn() },
					auth: { set: vi.fn() },
				} as any,
			} as any);

			const cfg: any = {
				provider: { openai: {} },
				command: {
					"codex-custom-user-command": { template: "custom" },
					"codex-auth": { template: "legacy" },
				},
				experimental: {
					primary_tools: ["codex-custom-user-command", "codex-auth"],
				},
			};
			await (plugin as any).config(cfg);

			expect(cfg.command["codex-custom-user-command"]).toBeDefined();
			expect(cfg.command["codex-auth"]).toBeUndefined();
			expect(cfg.experimental.primary_tools).toContain("codex-custom-user-command");
			expect(cfg.experimental.primary_tools).not.toContain("codex-auth");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
