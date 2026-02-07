import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_NAME } from "./constants.js";
import { getAuthDebugEnabled } from "./config.js";
import { getOpencodeLogDir, migrateLegacyLogDir } from "./paths.js";

// Logging configuration
export const LOGGING_ENABLED = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === "1";
export const DEBUG_ENABLED = getAuthDebugEnabled() || LOGGING_ENABLED;
const LOG_DIR = getOpencodeLogDir();
const REDACTED_VALUE = "[redacted]";
const REDACTED_KEYS = new Set(["prompt_cache_key"]);

migrateLegacyLogDir();

// Log startup message about logging state
if (LOGGING_ENABLED) {
	console.log(`[${PLUGIN_NAME}] Request logging ENABLED - logs will be saved to:`, LOG_DIR);
}
if (DEBUG_ENABLED && !LOGGING_ENABLED) {
	console.log(`[${PLUGIN_NAME}] Debug logging ENABLED`);
}

let requestCounter = 0;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function sanitizeLogValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeLogValue(entry));
	}
	if (!isPlainObject(value)) return value;

	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (REDACTED_KEYS.has(key)) {
			sanitized[key] = REDACTED_VALUE;
			continue;
		}
		sanitized[key] = sanitizeLogValue(entry);
	}
	return sanitized;
}

/**
 * Log request data to file (only when LOGGING_ENABLED is true)
 * @param stage - The stage of the request (e.g., "before-transform", "after-transform")
 * @param data - The data to log
 */
export function logRequest(stage: string, data: Record<string, unknown>): void {
	// Only log if explicitly enabled via environment variable
	if (!LOGGING_ENABLED) return;

	// Ensure log directory exists on first log
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}

	const timestamp = new Date().toISOString();
	const requestId = ++requestCounter;
	const filename = join(LOG_DIR, `request-${requestId}-${stage}.json`);

	try {
		const sanitized = sanitizeLogValue(data) as Record<string, unknown>;
		writeFileSync(
			filename,
			JSON.stringify(
				{
					timestamp,
					requestId,
					stage,
					...sanitized,
				},
				null,
				2,
			),
			{ encoding: "utf8", mode: 0o600 },
		);
		// Silenced to avoid TUI corruption
		// console.log(`[${PLUGIN_NAME}] Logged ${stage} to ${filename}`);
	} catch (e) {
		const error = e as Error;
		// Use stderr for actual failures but only if not in TUI mode or explicitly debugging
		if (DEBUG_ENABLED) {
			console.error(`[${PLUGIN_NAME}] Failed to write log:`, error.message);
		}
	}
}

/**
 * Log debug information (only when DEBUG_ENABLED is true)
 * @param message - Debug message
 * @param data - Optional data to log
 */
export function logDebug(message: string, data?: unknown): void {
	const loggingEnabled = process.env.ENABLE_PLUGIN_REQUEST_LOGGING === "1";
	if (!DEBUG_ENABLED && !loggingEnabled) return;

	if (data !== undefined) {
		console.log(`[${PLUGIN_NAME}] ${message}`, data);
	} else {
		console.log(`[${PLUGIN_NAME}] ${message}`);
	}
}

/**
 * Log warning (only when DEBUG or LOGGING is enabled)
 * @param message - Warning message
 * @param data - Optional data to log
 */
export function logWarn(message: string, data?: unknown): void {
	if (!DEBUG_ENABLED && !LOGGING_ENABLED) return;
	if (data !== undefined) {
		console.warn(`[${PLUGIN_NAME}] ${message}`, data);
	} else {
		console.warn(`[${PLUGIN_NAME}] ${message}`);
	}
}

/**
 * Log critical issues (always enabled - bypasses debug flags)
 * Use sparingly for issues that users must see regardless of debug settings.
 * @param message - Critical message
 * @param data - Optional data to log
 */
export function logCritical(message: string, data?: unknown): void {
	if (data !== undefined) {
		console.error(`[${PLUGIN_NAME}] ${message}`, data);
	} else {
		console.error(`[${PLUGIN_NAME}] ${message}`);
	}
}
