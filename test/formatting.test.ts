import { describe, it, expect } from "vitest";

import {
	formatRateLimitStatusMessage,
	formatStatusMessage,
	formatToastMessage,
	truncatePath,
} from "../lib/formatting.js";

describe("formatting", () => {
	it("truncatePath shortens long paths", () => {
		const path = "/Users/bryanfont/.config/opencode/openai-codex-accounts.json";
		const truncated = truncatePath(path, 40);
		expect(truncated).toContain("…");
		expect(truncated.length).toBeLessThanOrEqual(40);
		expect(truncated).toContain("openai-codex-accounts.json");
	});

	it("truncatePath clamps tiny max lengths", () => {
		const truncated = truncatePath("/tmp/something.json", 2);
		expect(truncated.length).toBeLessThanOrEqual(2);
		expect(truncated).toContain("…");
	});

	it("formatToastMessage truncates long paths", () => {
		const path =
			"/Users/bryanfont/.config/opencode/openai-codex-accounts.json.quarantine-123.json";
		const message = `Auto-repair failed. Quarantined: ${path}`;
		const formatted = formatToastMessage(message);
		expect(formatted.length).toBeLessThan(message.length);
		expect(formatted).not.toContain(path);
	});

	it("formatStatusMessage clamps length", () => {
		const message = "x".repeat(500);
		const formatted = formatStatusMessage(message);
		expect(formatted.length).toBeLessThanOrEqual(120);
		expect(formatted).toContain("…");
	});

	it("formatRateLimitStatusMessage clamps long status messages", () => {
		const message = formatRateLimitStatusMessage({
			accountCount: 2,
			waitMs: 120_000,
			storagePath:
				"/Users/bryanfont/.config/opencode/openai-codex-accounts.json.quarantine-123.json",
		});
		expect(message).toContain("rate-limited");
		expect(message.length).toBeLessThanOrEqual(120);
		expect(message).toContain("…");
	});
});
