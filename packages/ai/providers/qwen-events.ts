/**
 * Qwen Code stream-json mapping — shared between Bun and Node.js providers.
 *
 * Pure function, no runtime-specific dependencies.
 *
 * Qwen Code (`qwen -o stream-json --include-partial-messages`) writes one
 * JSON object per stdout line. Verified against Qwen Code 0.25.0:
 *
 *   system/init  — carries the model and qwen_code_version. The session
 *                  handles it (toolVersion), it maps to nothing.
 *   stream_event — Anthropic-style events. Only `content_block_delta` with a
 *                  `text_delta` delta is surfaced; `thinking_delta` and
 *                  `input_json_delta` are ignored (the complete tool input
 *                  arrives in the assistant line, not as a delta).
 *   assistant    — one line per content-block group (a thinking block, a
 *                  tool_use block, or a text block — not one per response).
 *                  text blocks map to `text`, tool_use blocks to `tool_use`.
 *   user         — tool results: message.content[] entries of type
 *                  `tool_result` (content is a string or a block array).
 *   result       — the final answer; ends the query.
 *
 * Lines emitted from a subagent carry its `parent_tool_use_id`; Ask AI
 * surfaces the top-level run only, so those are dropped.
 */

import type { AIMessage } from "../types.ts";

/**
 * Map one Qwen Code stream-json line to AIMessage[].
 */
export function mapQwenLine(
	line: Record<string, unknown>,
	sessionId: string,
): AIMessage[] {
	if (line.parent_tool_use_id != null) return [];

	switch (line.type as string) {
		case "stream_event": {
			const event = line.event as Record<string, unknown> | undefined;
			if (event?.type !== "content_block_delta") return [];
			const delta = event.delta as Record<string, unknown> | undefined;
			if (delta?.type !== "text_delta" || typeof delta.text !== "string") return [];
			return [{ type: "text_delta", delta: delta.text }];
		}

		case "assistant": {
			const message = line.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
			const content = message.content as Array<Record<string, unknown>>;
			const out: AIMessage[] = [];
			const text = content
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("");
			if (text) out.push({ type: "text", text });
			for (const block of content) {
				if (block?.type !== "tool_use") continue;
				out.push({
					type: "tool_use",
					toolName: typeof block.name === "string" ? block.name : "",
					toolInput: (block.input as Record<string, unknown>) ?? {},
					toolUseId: typeof block.id === "string" ? block.id : "",
				});
			}
			return out;
		}

		case "user": {
			const message = line.message as Record<string, unknown> | undefined;
			if (message?.role !== "user" || !Array.isArray(message.content)) return [];
			const out: AIMessage[] = [];
			for (const block of message.content as Array<Record<string, unknown>>) {
				if (block?.type !== "tool_result") continue;
				const resultText = toolResultText(block.content);
				out.push({
					type: "tool_result",
					toolUseId:
						typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
					result:
						block.is_error === true
							? `[Error] ${resultText || "Tool execution failed"}`
							: resultText,
				});
			}
			return out;
		}

		case "result": {
			const message: AIMessage = {
				type: "result",
				sessionId:
					typeof line.session_id === "string" ? line.session_id : sessionId,
				success: line.is_error !== true,
				...(typeof line.result === "string" ? { result: line.result } : {}),
				...(typeof line.num_turns === "number" ? { turns: line.num_turns } : {}),
			};
			return [message];
		}

		default:
			return [];
	}
}

/**
 * A `tool_result` content is a string or an array of blocks; the array form
 * keeps its `text` blocks (other block kinds carry no text the chat needs).
 */
function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is Record<string, unknown> =>
					typeof block === "object" && block !== null && block.type === "text",
			)
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.filter((text) => text !== "")
			.join("\n");
	}
	if (content == null) return "";
	return JSON.stringify(content);
}
