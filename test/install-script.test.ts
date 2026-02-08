import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";

const SCRIPT_PATH = resolve(
  process.cwd(),
  "scripts",
  "install-opencode-codex-auth.js",
);
const EXPECTED_PLUGIN_LATEST = "opencode-openai-codex-multi-auth@latest";

const runInstaller = (
  args: string[],
  homeDir: string,
  envOverrides: Record<string, string> = {},
) => {
  return execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
    env: { ...process.env, HOME: homeDir, ...envOverrides },
    stdio: "pipe",
    encoding: "utf8",
  });
};

const readJsoncFile = (path: string) => {
  const content = readFileSync(path, "utf-8");
  return { content, data: parse(content) as Record<string, any> };
};

const makeHome = () => mkdtempSync(join(tmpdir(), "opencode-install-"));

const writeConfig = (homeDir: string, file: string, content: string) => {
  const configDir = join(homeDir, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, file);
  writeFileSync(path, content);
  return path;
};

describe("Install script", () => {
  it("updates existing JSONC and preserves comments", () => {
    const homeDir = makeHome();
    const configPath = writeConfig(
      homeDir,
      "opencode.jsonc",
      `{
	  // My existing config
	  "plugin": ["some-other-plugin@1.2.3", "opencode-openai-codex-auth@4.2.0"],
	  "provider": {
	    "openai": {
	      "timeout": 60000,
      "models": { "custom-model": { "name": "Custom" } }
    }
  }
}`,
    );

    runInstaller(["--no-cache-clear"], homeDir);

    const { content, data } = readJsoncFile(configPath);
    expect(content).toContain("// My existing config");
    expect(data.plugin).toContain(EXPECTED_PLUGIN_LATEST);
    expect(data.plugin).toContain("some-other-plugin@1.2.3");
    expect(data.provider.openai.timeout).toBe(60000);
    expect(data.provider.openai.models["custom-model"]).toBeDefined();
    expect(data.provider.openai.models["gpt-5.2"]).toBeDefined();
  });

  it("prefers JSONC when both jsonc and json exist", () => {
    const homeDir = makeHome();
    const jsoncPath = writeConfig(
      homeDir,
      "opencode.jsonc",
      `{ "plugin": ["opencode-openai-codex-auth@4.2.0"] }`,
    );
    const jsonPath = writeConfig(
      homeDir,
      "opencode.json",
      `{ "plugin": ["should-stay"], "provider": { "openai": { "timeout": 10 } } }`,
    );
    const jsonBefore = readFileSync(jsonPath, "utf-8");

    runInstaller(["--no-cache-clear"], homeDir);

    const { data } = readJsoncFile(jsoncPath);
    expect(data.plugin).toContain(EXPECTED_PLUGIN_LATEST);
    const jsonAfter = readFileSync(jsonPath, "utf-8");
    expect(jsonAfter).toBe(jsonBefore);
  });

  it("creates JSONC when no config exists", () => {
    const homeDir = makeHome();
    runInstaller(["--no-cache-clear"], homeDir);
    const configPath = join(homeDir, ".config", "opencode", "opencode.jsonc");
    expect(existsSync(configPath)).toBe(true);
    const { data } = readJsoncFile(configPath);
    expect(data.plugin).toContain(EXPECTED_PLUGIN_LATEST);
  });

  it("uses online template when available", () => {
    const homeDir = makeHome();
    const releaseApiUrl =
      "https://api.github.com/repos/iam-brain/opencode-openai-codex-multi-auth/releases/latest";
    const templateUrl =
      "https://raw.githubusercontent.com/iam-brain/opencode-openai-codex-multi-auth/vtest/config/opencode-modern.json";

    runInstaller(["--no-cache-clear"], homeDir, {
      OPENCODE_TEST_ALLOW_ONLINE_TEMPLATE: "1",
      OPENCODE_TEST_FETCH_MOCKS: JSON.stringify({
        [releaseApiUrl]: {
          status: 200,
          json: { tag_name: "vtest" },
        },
        [templateUrl]: {
          status: 200,
          json: {
            provider: {
              openai: {
                models: {
                  "online-only-model": {
                    options: { reasoningEffort: "high" },
                  },
                },
              },
            },
          },
        },
      }),
    });

    const configPath = join(homeDir, ".config", "opencode", "opencode.jsonc");
    const { data } = readJsoncFile(configPath);
    expect(data.provider.openai.models["online-only-model"]).toBeDefined();
  });

  it("falls back to static template when online template payload is malformed", () => {
    const homeDir = makeHome();
    const releaseApiUrl =
      "https://api.github.com/repos/iam-brain/opencode-openai-codex-multi-auth/releases/latest";
    const templateUrl =
      "https://raw.githubusercontent.com/iam-brain/opencode-openai-codex-multi-auth/vtest/config/opencode-modern.json";

    runInstaller(["--no-cache-clear"], homeDir, {
      OPENCODE_TEST_ALLOW_ONLINE_TEMPLATE: "1",
      OPENCODE_TEST_FETCH_MOCKS: JSON.stringify({
        [releaseApiUrl]: {
          status: 200,
          json: { tag_name: "vtest" },
        },
        [templateUrl]: {
          status: 200,
          json: {
            provider: {
              openai: {
                models: [],
              },
            },
          },
        },
      }),
    });

    const configPath = join(homeDir, ".config", "opencode", "opencode.jsonc");
    const { data } = readJsoncFile(configPath);
    expect(data.provider.openai.models["online-only-model"]).toBeUndefined();
    expect(data.provider.openai.models["gpt-5.2"]).toBeDefined();
  });

  it("rejects disallowed endpoint override hosts in test mode", () => {
    const homeDir = makeHome();
    const output = runInstaller(["--no-cache-clear"], homeDir, {
      OPENCODE_TEST_ALLOW_ONLINE_TEMPLATE: "1",
      OPENCODE_INSTALLER_TEST_MODE: "1",
      OPENCODE_TEMPLATE_RELEASE_API: "https://evil.example/releases/latest",
      OPENCODE_TEMPLATE_RAW_BASE: "https://evil.example",
    });

    expect(output).toContain(
      "Ignoring release endpoint override with disallowed host",
    );
    expect(output).toContain(
      "Ignoring raw endpoint override with disallowed host",
    );
  });

  it("ignores endpoint overrides outside test mode", () => {
    const homeDir = makeHome();
    const output = runInstaller(["--no-cache-clear"], homeDir, {
      VITEST: "",
      OPENCODE_INSTALLER_TEST_MODE: "0",
      OPENCODE_TEST_ALLOW_ONLINE_TEMPLATE: "1",
      OPENCODE_TEMPLATE_RELEASE_API: "http://localhost:7777/releases/latest",
      OPENCODE_TEMPLATE_RAW_BASE: "http://localhost:7777",
    });

    expect(output).toContain(
      "Ignoring release endpoint override outside test mode",
    );
    expect(output).toContain(
      "Ignoring raw endpoint override outside test mode",
    );
  });

  it("preserves pinned plugin versions", () => {
    const homeDir = makeHome();
    const configPath = writeConfig(
      homeDir,
      "opencode.jsonc",
      `{ "plugin": ["opencode-openai-codex-multi-auth@4.4.0", "some-other-plugin@1.2.3"] }`,
    );

    runInstaller(["--no-cache-clear"], homeDir);

    const { data } = readJsoncFile(configPath);
    expect(data.plugin).toContain("opencode-openai-codex-multi-auth@4.4.0");
    expect(data.plugin).not.toContain(EXPECTED_PLUGIN_LATEST);
  });

  it("rewrites unpinned plugin to @latest", () => {
    const homeDir = makeHome();
    const configPath = writeConfig(
      homeDir,
      "opencode.jsonc",
      `{ "plugin": ["opencode-openai-codex-multi-auth", "some-other-plugin@1.2.3"] }`,
    );

    runInstaller(["--no-cache-clear"], homeDir);

    const { data } = readJsoncFile(configPath);
    expect(data.plugin).not.toContain("opencode-openai-codex-multi-auth");
    expect(data.plugin).toContain(EXPECTED_PLUGIN_LATEST);
  });

  it("does not remove plugins that merely contain alias substrings", () => {
    const homeDir = makeHome();
    const configPath = writeConfig(
      homeDir,
      "opencode.jsonc",
      `{ "plugin": ["opencode-openai-codex-multi-auth-helper@1.0.0", "opencode-openai-codex-auth@4.2.0"] }`,
    );

    runInstaller(["--no-cache-clear"], homeDir);

    const { data } = readJsoncFile(configPath);
    expect(data.plugin).toContain(
      "opencode-openai-codex-multi-auth-helper@1.0.0",
    );
    expect(data.plugin).toContain(EXPECTED_PLUGIN_LATEST);
  });

  it("uninstall removes plugin models but keeps custom config", () => {
    const homeDir = makeHome();
    const configPath = writeConfig(
      homeDir,
      "opencode.jsonc",
      `{
	  "plugin": ["some-other-plugin@1.2.3", "opencode-openai-codex-auth@4.2.0"],
	  "provider": {
    "openai": {
      "timeout": 60000,
      "models": {
        "custom-model": { "name": "Custom" },
        "gpt-5.2": { "name": "GPT 5.2 (Codex)" },
        "gpt-5.2-codex": { "name": "GPT 5.2 Codex (Codex)" }
      }
    },
    "anthropic": { "models": { "claude": { "name": "Claude" } } }
  }
}`,
    );

    runInstaller(["--uninstall", "--no-cache-clear"], homeDir);

    const { data } = readJsoncFile(configPath);
    expect(data.plugin).toEqual(["some-other-plugin@1.2.3"]);
    expect(data.provider.openai.timeout).toBe(60000);
    expect(data.provider.openai.models["custom-model"]).toBeDefined();
    expect(data.provider.openai.models["gpt-5.2"]).toBeUndefined();
    expect(data.provider.openai.models["gpt-5.2-codex"]).toBeUndefined();
    expect(data.provider.anthropic).toBeDefined();
  });

  it("uninstall --all removes plugin artifacts", () => {
    const homeDir = makeHome();
    writeConfig(
      homeDir,
      "opencode.jsonc",
      `{ "plugin": ["opencode-openai-codex-auth@4.2.0"] }`,
    );

    const opencodeDir = join(homeDir, ".opencode");
    const configDir = join(homeDir, ".config", "opencode");
    mkdirSync(join(opencodeDir, "auth"), { recursive: true });
    mkdirSync(join(opencodeDir, "logs", "codex-plugin"), { recursive: true });
    mkdirSync(join(opencodeDir, "cache"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(configDir, "auth"), { recursive: true });
    mkdirSync(join(configDir, "logs", "codex-plugin"), { recursive: true });
    mkdirSync(join(configDir, "cache"), { recursive: true });
    writeFileSync(join(opencodeDir, "auth", "openai.json"), "{}");
    writeFileSync(join(configDir, "auth", "openai.json"), "{}");
    writeFileSync(join(opencodeDir, "openai-codex-auth-config.json"), "{}");
    writeFileSync(join(opencodeDir, "openai-codex-accounts.json"), "{}");
    writeFileSync(join(configDir, "openai-codex-auth-config.json"), "{}");
    writeFileSync(join(configDir, "openai-codex-accounts.json"), "{}");
    writeFileSync(join(opencodeDir, "logs", "codex-plugin", "log.txt"), "log");
    writeFileSync(join(opencodeDir, "cache", "codex-instructions.md"), "cache");
    writeFileSync(join(configDir, "logs", "codex-plugin", "log.txt"), "log");
    writeFileSync(join(configDir, "cache", "codex-instructions.md"), "cache");

    runInstaller(["--uninstall", "--all", "--no-cache-clear"], homeDir);

    expect(existsSync(join(opencodeDir, "auth", "openai.json"))).toBe(false);
    expect(existsSync(join(configDir, "auth", "openai.json"))).toBe(false);
    expect(existsSync(join(opencodeDir, "openai-codex-auth-config.json"))).toBe(
      false,
    );
    expect(existsSync(join(opencodeDir, "openai-codex-accounts.json"))).toBe(
      false,
    );
    expect(existsSync(join(configDir, "openai-codex-auth-config.json"))).toBe(
      false,
    );
    expect(existsSync(join(configDir, "openai-codex-accounts.json"))).toBe(
      false,
    );
    expect(existsSync(join(opencodeDir, "logs", "codex-plugin"))).toBe(false);
    expect(
      existsSync(join(opencodeDir, "cache", "codex-instructions.md")),
    ).toBe(false);
    expect(existsSync(join(configDir, "logs", "codex-plugin"))).toBe(false);
    expect(existsSync(join(configDir, "cache", "codex-instructions.md"))).toBe(
      false,
    );
  });
});
