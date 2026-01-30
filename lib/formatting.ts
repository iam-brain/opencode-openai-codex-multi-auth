import { formatWaitTime } from "./accounts.js";

const MAX_TOAST_MESSAGE_LENGTH = 160;
const MAX_STATUS_MESSAGE_LENGTH = 120;
const MAX_TOKEN_LENGTH = 48;
const MAX_PATH_LENGTH = 48;

function truncateMiddle(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (value.length <= maxLength) return value;
	if (maxLength === 1) return "…";
	const head = Math.max(1, Math.floor(maxLength * 0.4));
	const tail = Math.max(0, maxLength - head - 1);
	if (tail === 0) return `${value.slice(0, head)}…`;
	return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function truncatePath(path: string, maxLength: number = MAX_PATH_LENGTH): string {
	if (path.length <= maxLength) return path;
	const parts = path.split(/[\\/]/);
	const last = parts[parts.length - 1] ?? path;
	if (last.length + 2 >= maxLength) {
		return truncateMiddle(last, maxLength);
	}
	const headLen = Math.max(1, maxLength - last.length - 1);
	return `${path.slice(0, headLen)}…${last}`;
}

function normalizeWhitespace(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

function truncateToken(token: string, maxTokenLength: number, maxPathLength: number): string {
	if (token.length <= maxTokenLength) return token;
	if (token.includes("/") || token.includes("\\")) {
		return truncatePath(token, maxPathLength);
	}
	return truncateMiddle(token, maxTokenLength);
}

function clampMessage(message: string, maxLength: number): string {
	if (message.length <= maxLength) return message;
	return truncateMiddle(message, maxLength);
}

export function formatToastMessage(message: string): string {
	const normalized = normalizeWhitespace(message);
	const tokens = normalized.split(" ");
	const formatted = tokens
		.map((token) => truncateToken(token, MAX_TOKEN_LENGTH, MAX_PATH_LENGTH))
		.join(" ");
	return clampMessage(formatted, MAX_TOAST_MESSAGE_LENGTH);
}

export function formatStatusMessage(message: string): string {
	const normalized = normalizeWhitespace(message);
	const tokens = normalized.split(" ");
	const formatted = tokens
		.map((token) => truncateToken(token, MAX_TOKEN_LENGTH, MAX_PATH_LENGTH))
		.join(" ");
	return clampMessage(formatted, MAX_STATUS_MESSAGE_LENGTH);
}

export function formatRateLimitStatusMessage(options: {
	accountCount: number;
	waitMs: number;
	storagePath: string;
}): string {
	if (options.accountCount === 0) {
		return formatStatusMessage("No OpenAI accounts configured. Run `opencode auth login`.");
	}
	const waitLabel = options.waitMs > 0 ? formatWaitTime(options.waitMs) : "a bit";
	const storagePath = truncatePath(options.storagePath, MAX_PATH_LENGTH);
	const message = `All ${options.accountCount} account(s) are temporarily unavailable. Try again in ${waitLabel} or add another account with \`opencode auth login\`. (Storage: ${storagePath})`;
	return formatStatusMessage(message);
}
