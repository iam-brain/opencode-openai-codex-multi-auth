import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
	getOpencodeConfigDir,
	getOpencodeCacheDir,
	getOpencodeLogDir,
	migrateLegacyCacheFiles,
	migrateLegacyLogDir,
} from "../lib/paths.js";

describe("paths", () => {
	const originalXdg = process.env.XDG_CONFIG_HOME;
	const originalHome = process.env.OPENCODE_HOME;
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(os.tmpdir(), "opencode-paths-"));
		process.env.OPENCODE_HOME = root;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.OPENCODE_HOME;
		} else {
			process.env.OPENCODE_HOME = originalHome;
		}
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("uses XDG_CONFIG_HOME for config dir", () => {
		const xdg = join(root, "xdg");
		process.env.XDG_CONFIG_HOME = xdg;
		expect(getOpencodeConfigDir()).toBe(join(xdg, "opencode"));
	});

	it("derives cache and log dirs from config dir", () => {
		const xdg = join(root, "xdg");
		process.env.XDG_CONFIG_HOME = xdg;
		expect(getOpencodeCacheDir()).toBe(join(xdg, "opencode", "cache"));
		expect(getOpencodeLogDir()).toBe(join(xdg, "opencode", "logs", "codex-plugin"));
	});

	it("migrates legacy cache files", () => {
		const xdg = join(root, "xdg");
		process.env.XDG_CONFIG_HOME = xdg;

		const legacyCacheDir = join(root, ".opencode", "cache");
		const legacyFile = join(legacyCacheDir, "codex-instructions.md");
		mkdirSync(legacyCacheDir, { recursive: true });
		writeFileSync(legacyFile, "legacy");

		migrateLegacyCacheFiles(["codex-instructions.md"]);

		const newFile = join(xdg, "opencode", "cache", "codex-instructions.md");
		expect(readFileSync(newFile, "utf-8")).toBe("legacy");
		expect(existsSync(legacyFile)).toBe(false);
	});

	it("migrates legacy log directory contents", () => {
		const xdg = join(root, "xdg");
		process.env.XDG_CONFIG_HOME = xdg;

		const legacyLogDir = join(root, ".opencode", "logs", "codex-plugin");
		const legacyLog = join(legacyLogDir, "request-1.json");
		mkdirSync(legacyLogDir, { recursive: true });
		writeFileSync(legacyLog, "log");

		migrateLegacyLogDir();

		const newLog = join(xdg, "opencode", "logs", "codex-plugin", "request-1.json");
		expect(readFileSync(newLog, "utf-8")).toBe("log");
		expect(existsSync(legacyLog)).toBe(false);
	});
});
