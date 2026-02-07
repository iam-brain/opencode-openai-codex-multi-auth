import { logRequest, LOGGING_ENABLED, logWarn } from "../logger.js";
import type { SSEEventData } from "../types.js";
import { codexStatus } from "../codex-status.js";

/**
 * Parse SSE stream to extract final response and rate limits
 * @param sseText - Complete SSE stream text
 * @param account - Account record to update snapshots for
 * @returns Final response object or null if not found
 */
async function parseSseStream(sseText: string, account?: any): Promise<unknown | null> {
	const lines = sseText.split('\n');
	let finalResponse = null;

	for (const line of lines) {
		if (line.startsWith('data: ')) {
			try {
				const data = JSON.parse(line.substring(6)) as SSEEventData;

				// Handle token_count event with rate limits
				if (data.type === 'token_count' && (data as any).rate_limits && account) {
					await codexStatus.updateFromSnapshot(account, (data as any).rate_limits);
				}

				// Look for response.done event with final data
				if (data.type === 'response.done' || data.type === 'response.completed') {
					finalResponse = data.response;
				}
			} catch (e) {
				// Skip malformed JSON
			}
		}
	}

	return finalResponse;
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @param account - Account record
 * @returns Response with JSON body
 */
export async function convertSseToJson(response: Response, headers: Headers, account?: any): Promise<Response> {
	if (!response.body) {
		throw new Error('[openai-codex-plugin] Response has no body');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = '';

	try {
		// Consume the entire stream
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		// Parse SSE events to extract the final response and limits
		const finalResponse = await parseSseStream(fullText, account);

		if (!finalResponse) {
			logWarn('Could not find final response in SSE stream');
			logRequest("stream-error", { error: "No response.done event found" });

			// Return original stream if we can't parse
			return new Response(fullText, {
				status: response.status,
				statusText: response.statusText,
				headers: headers,
			});
		}

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		logWarn('Error converting stream:', error);
		logRequest("stream-error", { error: String(error) });
		throw error;
	}
}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}

export function createSyntheticErrorResponse(
	message: string,
	status = 400,
	type = "hard_stop",
	param?: string,
): Response {
	const errorPayload: { error: { message: string; type: string; param?: string } } = {
		error: {
			message,
			type,
		},
	};

	if (param) {
		errorPayload.error.param = param;
	}

	return new Response(JSON.stringify(errorPayload), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
