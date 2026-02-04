import type { TokenResult } from "./types.js";

export type RefreshQueueResult = TokenResult | { type: "skipped" };

export type RefreshQueueTask = {
	key: string;
	expires: number;
	refresh: () => Promise<TokenResult>;
};

type RefreshQueueOptions = {
	bufferMs?: number;
	intervalMs?: number;
	now?: () => number;
};

export class ProactiveRefreshQueue {
	private queue: Array<{
		task: RefreshQueueTask;
		resolve: (result: RefreshQueueResult) => void;
	}> = [];
	private pendingKeys = new Set<string>();
	private running = false;
	private bufferMs: number;
	private intervalMs: number;
	private now: () => number;

	constructor(options: RefreshQueueOptions = {}) {
		this.bufferMs = Math.max(0, Math.floor(options.bufferMs ?? 60_000));
		this.intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 250));
		this.now = options.now ?? (() => Date.now());
	}

	async enqueue(task: RefreshQueueTask): Promise<RefreshQueueResult> {
		let now = Date.now();
		try {
			now = this.now();
		} catch {
			now = Date.now();
		}

		if (!Number.isFinite(task.expires) || task.expires <= now) {
			return Promise.resolve({ type: "skipped" });
		}
		if (task.expires - now > this.bufferMs) {
			return Promise.resolve({ type: "skipped" });
		}
		if (this.pendingKeys.has(task.key)) {
			return Promise.resolve({ type: "skipped" });
		}

		return new Promise((resolve) => {
			this.pendingKeys.add(task.key);
			this.queue.push({ task, resolve });
			if (!this.running) {
				void this.process();
			}
		});
	}

	private async process(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (!item) continue;
				let now = Date.now();
				let result: RefreshQueueResult = { type: "skipped" };
				try {
					try {
						now = this.now();
					} catch {
						now = Date.now();
					}

					if (item.task.expires > now && item.task.expires - now <= this.bufferMs) {
						try {
							result = await item.task.refresh();
						} catch {
							result = { type: "failed" };
						}
					}
				} catch {
					result = { type: "failed" };
				} finally {
					this.pendingKeys.delete(item.task.key);
					// Ensure resolve is called even if errors occurred
					try {
						item.resolve(result);
					} catch {
					}
				}
				if (this.intervalMs > 0 && this.queue.length > 0) {
					await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
				}
			}
		} finally {
			this.running = false;
		}
	}
}

export type RefreshSchedulerOptions = {
	intervalMs: number;
	queue: ProactiveRefreshQueue;
	getTasks: () => RefreshQueueTask[];
};

export type RefreshScheduler = {
	start: () => void;
	stop: () => void;
};

export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
	let timer: ReturnType<typeof setInterval> | null = null;

	const tick = () => {
		const tasks = options.getTasks();
		for (const task of tasks) {
			void options.queue.enqueue(task);
		}
	};

	return {
		start() {
			if (timer) return;
			tick();
			if (options.intervalMs <= 0) return;
			timer = setInterval(tick, options.intervalMs);
			timer.unref?.();
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = null;
		},
	};
}
