import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";

import {
  saveRotationState,
  loadRotationState,
  withRotationStateLock,
  type RotationStateV1,
} from "../lib/rotation-state.js";
import { getOpencodeConfigDir } from "../lib/storage.js";

describe("rotation-state", () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-rotation-test-"));
    process.env.XDG_CONFIG_HOME = root;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    vi.restoreAllMocks();
  });

  const sampleState: RotationStateV1 = {
    version: 1,
    updatedAt: 1234567890,
    healthScores: {
      "account-1": { score: 80, lastUpdated: 1000, consecutiveFailures: 0 },
    },
    tokenBuckets: {
      "account-1": { tokens: 40, lastUpdated: 1000 },
    },
  };

  it("saveRotationState creates file with correct content", async () => {
    await saveRotationState(sampleState);

    const configDir = getOpencodeConfigDir();
    const statePath = join(configDir, "rotation-state.json");
    
    expect(existsSync(statePath)).toBe(true);
    const content = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(content).toEqual(sampleState);
  });

  it("saveRotationState sets correct permissions (0600)", async () => {
    await saveRotationState(sampleState);

    const configDir = getOpencodeConfigDir();
    const statePath = join(configDir, "rotation-state.json");
    
    if (process.platform !== "win32") {
      const stat = await fsPromises.stat(statePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("loadRotationState reads file correctly", async () => {
    await saveRotationState(sampleState);
    
    const loaded = await loadRotationState();
    expect(loaded).toEqual(sampleState);
  });

  it("loadRotationState returns null if file missing", async () => {
    const loaded = await loadRotationState();
    expect(loaded).toBeNull();
  });

  it("loadRotationState returns null if file corrupt", async () => {
    const configDir = getOpencodeConfigDir();
    mkdirSync(configDir, { recursive: true });
    const statePath = join(configDir, "rotation-state.json");
    await fsPromises.writeFile(statePath, "{ invalid json");

    const loaded = await loadRotationState();
    expect(loaded).toBeNull();
  });

  it("withRotationStateLock acquires lock", async () => {
    const lockSpy = vi.spyOn(lockfile, "lock");
    
    let insideLock = false;
    await withRotationStateLock(async () => {
      insideLock = true;
      const configDir = getOpencodeConfigDir();
      const statePath = join(configDir, "rotation-state.json");
      expect(lockSpy).toHaveBeenCalledWith(statePath, expect.anything());
    });
    
    expect(insideLock).toBe(true);
  });

  it("withRotationStateLock creates empty file if missing", async () => {
    await withRotationStateLock(async () => {
      const configDir = getOpencodeConfigDir();
      const statePath = join(configDir, "rotation-state.json");
      expect(existsSync(statePath)).toBe(true);
      const content = readFileSync(statePath, "utf-8");
      expect(content).toBe("{}");
    });
  });
});
