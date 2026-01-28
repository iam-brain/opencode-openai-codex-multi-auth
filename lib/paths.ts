import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const OPENCODE_DIR = "opencode";
const LEGACY_DIR = ".opencode";

export function getOpencodeConfigDir(): string {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome && xdgConfigHome.trim()) {
		return join(xdgConfigHome, OPENCODE_DIR);
	}
	return join(getHomeDir(), ".config", OPENCODE_DIR);
}

export function getOpencodeCacheDir(): string {
	return join(getOpencodeConfigDir(), "cache");
}

export function getOpencodeLogDir(): string {
	return join(getOpencodeConfigDir(), "logs", "codex-plugin");
}

function getLegacyOpencodeDir(): string {
	return join(getHomeDir(), LEGACY_DIR);
}

function getHomeDir(): string {
	const override = process.env.OPENCODE_HOME;
	if (override && override.trim()) return override;
	return homedir();
}

function getLegacyCacheDir(): string {
	return join(getLegacyOpencodeDir(), "cache");
}

function getLegacyLogDir(): string {
	return join(getLegacyOpencodeDir(), "logs", "codex-plugin");
}

function migrateLegacyFile(legacyPath: string, newPath: string): void {
	if (!existsSync(legacyPath)) return;
	if (existsSync(newPath)) return;

	try {
		mkdirSync(dirname(newPath), { recursive: true });
		try {
			renameSync(legacyPath, newPath);
			return;
		} catch {
			copyFileSync(legacyPath, newPath);
			unlinkSync(legacyPath);
		}
	} catch {
		// Best-effort migration; ignore.
	}
}

function migrateLegacyDirContents(legacyDir: string, newDir: string): void {
	if (!existsSync(legacyDir)) return;

	try {
		mkdirSync(newDir, { recursive: true });
		const entries = readdirSync(legacyDir);
		for (const entry of entries) {
			const legacyPath = join(legacyDir, entry);
			const newPath = join(newDir, entry);
			if (existsSync(newPath)) continue;
			try {
				renameSync(legacyPath, newPath);
			} catch {
				try {
					copyFileSync(legacyPath, newPath);
					unlinkSync(legacyPath);
				} catch {
					// ignore
				}
			}
		}
		try {
			if (readdirSync(legacyDir).length === 0) {
				rmSync(legacyDir, { recursive: true, force: true });
			}
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}

export function migrateLegacyCacheFiles(fileNames: string[]): void {
	const legacyDir = getLegacyCacheDir();
	const newDir = getOpencodeCacheDir();
	if (!existsSync(legacyDir)) return;

	for (const fileName of fileNames) {
		migrateLegacyFile(join(legacyDir, fileName), join(newDir, fileName));
	}
}

export function migrateLegacyLogDir(): void {
	migrateLegacyDirContents(getLegacyLogDir(), getOpencodeLogDir());
}
