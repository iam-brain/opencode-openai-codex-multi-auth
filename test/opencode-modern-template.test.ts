import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("opencode-modern template structure", () => {
  it("keeps codex model presets under provider.openai.models", () => {
    const filePath = join(process.cwd(), "config", "opencode-modern.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      provider?: {
        openai?: {
          models?: Record<string, unknown>;
          [key: string]: unknown;
        };
      };
    };

    const openai = parsed.provider?.openai ?? {};
    const models = openai.models ?? {};

    expect(models["gpt-5.3-codex"]).toBeDefined();
    expect(models["gpt-5.2-codex"]).toBeDefined();
    expect(openai["gpt-5.3-codex"]).toBeUndefined();
    expect(openai["gpt-5.2-codex"]).toBeUndefined();
  });
});
