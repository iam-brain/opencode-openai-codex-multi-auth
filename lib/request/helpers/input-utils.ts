import type { InputItem } from "../../types.js";

const getCallId = (item: InputItem): string | null => {
	const rawCallId = (item as { call_id?: unknown }).call_id;
	if (typeof rawCallId !== "string") return null;
	const trimmed = rawCallId.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const convertOrphanedOutputToMessage = (
	item: InputItem,
	callId: string | null,
): InputItem => {
	const toolName =
		typeof (item as { name?: unknown }).name === "string"
			? ((item as { name?: string }).name as string)
			: "tool";
	const labelCallId = callId ?? "unknown";
	let text: string;
	try {
		const out = (item as { output?: unknown }).output;
		text = typeof out === "string" ? out : JSON.stringify(out);
	} catch {
		text = String((item as { output?: unknown }).output ?? "");
	}
	if (text.length > 16000) {
		text = text.slice(0, 16000) + "\n...[truncated]";
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${labelCallId}]: ${text}`,
	} as InputItem;
};

const collectCallIds = (input: InputItem[]) => {
	const functionCallIds = new Set<string>();
	const localShellCallIds = new Set<string>();
	const customToolCallIds = new Set<string>();

	for (const item of input) {
		const callId = getCallId(item);
		if (!callId) continue;
		switch (item.type) {
			case "function_call":
				functionCallIds.add(callId);
				break;
			case "local_shell_call":
				localShellCallIds.add(callId);
				break;
			case "custom_tool_call":
				customToolCallIds.add(callId);
				break;
			default:
				break;
		}
	}

	return { functionCallIds, localShellCallIds, customToolCallIds };
};

export const normalizeOrphanedToolOutputs = (
	input: InputItem[],
): InputItem[] => {
	const { functionCallIds, localShellCallIds, customToolCallIds } =
		collectCallIds(input);

	return input.map((item) => {
		if (item.type === "function_call_output") {
			const callId = getCallId(item);
			const hasMatch =
				!!callId &&
				(functionCallIds.has(callId) || localShellCallIds.has(callId));
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (item.type === "custom_tool_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && customToolCallIds.has(callId);
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		if (item.type === "local_shell_call_output") {
			const callId = getCallId(item);
			const hasMatch = !!callId && localShellCallIds.has(callId);
			if (!hasMatch) {
				return convertOrphanedOutputToMessage(item, callId);
			}
		}

		return item;
	});
};
