import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getOpencodeConfigDir } from "./storage.js";

const STATE_FILE = "rotation-state.json";
const LOCK_OPTIONS = { stale: 10000, retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 } };

export interface PersistedHealthScore {
  score: number;
  lastUpdated: number;
  consecutiveFailures: number;
}

export interface PersistedTokenBucket {
  tokens: number;
  lastUpdated: number;
}

export interface RotationStateV1 {
  version: 1;
  healthScores: Record<string, PersistedHealthScore>;
  tokenBuckets: Record<string, PersistedTokenBucket>;
  updatedAt: number;
}

function getStatePath(): string {
  return join(getOpencodeConfigDir(), STATE_FILE);
}

export async function loadRotationState(): Promise<RotationStateV1 | null> {
  const path = getStatePath();
  if (!existsSync(path)) return null;
  try {
    const content = await fs.readFile(path, "utf-8");
    return JSON.parse(content) as RotationStateV1;
  } catch {
    return null;
  }
}

export async function saveRotationState(state: RotationStateV1): Promise<void> {
  const path = getStatePath();
  const dir = getOpencodeConfigDir();
  await fs.mkdir(dir, { recursive: true });
  
  const tempPath = `${path}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, path);
}

export async function withRotationStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = getStatePath();
  const dir = getOpencodeConfigDir();
  await fs.mkdir(dir, { recursive: true });
  
  if (!existsSync(path)) {
    await fs.writeFile(path, "{}", { mode: 0o600 });
  }
  
  const release = await lockfile.lock(path, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
