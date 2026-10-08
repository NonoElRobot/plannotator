import { describe, expect, test } from "bun:test";
import { mapQwenLine } from "./qwen-events.ts";

/**
 * mapQwenLine over REAL Qwen Code stream-json output. Every fixture line is
 * copied verbatim from a `qwen -o stream-json --include-partial-messages`
 * run (Qwen Code 0.25.0, --approval-mode plan, one read_file turn) — the
 * probe-marker exchange: the model thinks, reads probe-marker.txt and
 * answers with its content. The `system/init` line is trimmed only where
 * the mapper provably looks at nothing (the tools/slash_commands/agents
 * lists); every other line is byte-exact.
 */

const SESSION_ID = "6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b";
const TOOL_ID = "Q673iM04W3rG0pJKnXOTsR5zmwmKdg8a";
const FILE_PATH = "C:\\Users\\Nono\\AppData\\Local\\Temp\\plannotator-qwen-test\\project\\probe-marker.txt";

const lines: Record<string, Record<string, unknown>> = {};
const raw: Record<string, string> = {
	init: String.raw`{"type":"system","subtype":"init","uuid":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","cwd":"C:\\Users\\Nono\\AppData\\Local\\Temp\\plannotator-qwen-test\\project","model":"Qwen3.8-27B-UD-Q8_K_XL","permission_mode":"plan","qwen_code_version":"0.25.0"}`,
	goalState: String.raw`{"type":"stream_event","uuid":"39c4662e-a778-493d-9179-e48bd43fae1f","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"goal_state","goal_state":{"v":2,"goal":null,"activity":"idle"}}}`,
	messageStart: String.raw`{"type":"stream_event","uuid":"7c4f9d46-d97e-4df1-b502-1059af907eb9","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"message_start","message":{"id":"e1d1ae7c-0ae1-4dbc-8371-82fa4e29de88","role":"assistant","model":"Qwen3.8-27B-UD-Q8_K_XL","content":[]}}}`,
	blockStart: String.raw`{"type":"stream_event","uuid":"4f64bbab-595f-4960-91d1-c99db8191464","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}`,
	thinkingDelta: String.raw`{"type":"stream_event","uuid":"8627146d-b6c7-4e3f-bbbd-70e07dd79269","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}}`,
	textDelta: String.raw`{"type":"stream_event","uuid":"f564204f-1e46-45cc-a862-44adfa8fd584","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"MARK"}}}`,
	inputJsonDelta: String.raw`{"type":"stream_event","uuid":"4bea9b81-36aa-46ab-8965-d8838e67a7cd","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"C:\\\\Users\\\\Nono\\\\AppData\\\\Local\\\\Temp\\\\plannotator-qwen-test\\\\project\\\\probe-marker.txt\"}"}}}`,
	blockStop: String.raw`{"type":"stream_event","uuid":"2bf3abd2-5de4-42cb-9177-11da83be6a07","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":0}}`,
	messageStop: String.raw`{"type":"stream_event","uuid":"8b8a8ec7-3b0d-4eea-a7f7-0d26354f9cfc","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"event":{"type":"message_stop"}}`,
	assistantThinking: String.raw`{"type":"assistant","uuid":"e1d1ae7c-0ae1-4dbc-8371-82fa4e29de88","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"message":{"id":"e1d1ae7c-0ae1-4dbc-8371-82fa4e29de88","type":"message","role":"assistant","model":"Qwen3.8-27B-UD-Q8_K_XL","content":[{"type":"thinking","thinking":"Plan mode is active — however, reading files is a read-only operation, and this is permitted. Let's read probe-marker.txt.\n","signature":""}],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}`,
	assistantToolUse: String.raw`{"type":"assistant","uuid":"db5e4d8d-0363-47d3-8c11-884a888545f0","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"message":{"id":"db5e4d8d-0363-47d3-8c11-884a888545f0","type":"message","role":"assistant","model":"Qwen3.8-27B-UD-Q8_K_XL","content":[{"type":"tool_use","id":"Q673iM04W3rG0pJKnXOTsR5zmwmKdg8a","name":"read_file","input":{"file_path":"C:\\Users\\Nono\\AppData\\Local\\Temp\\plannotator-qwen-test\\project\\probe-marker.txt"}}],"stop_reason":"tool_use","usage":{"input_tokens":19813,"output_tokens":79,"cache_read_input_tokens":12766,"total_tokens":19892}}}`,
	userToolResult: String.raw`{"type":"user","uuid":"073d0091-f770-4ca3-9cc3-66830699feed","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"Q673iM04W3rG0pJKnXOTsR5zmwmKdg8a","is_error":false,"content":"MARKER-CONTENT-42\n"}]}}`,
	assistantText: String.raw`{"type":"assistant","uuid":"66ecdfe7-c730-450a-8783-f4bbe41e3f65","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","parent_tool_use_id":null,"message":{"id":"66ecdfe7-c730-450a-8783-f4bbe41e3f65","type":"message","role":"assistant","model":"Qwen3.8-27B-UD-Q8_K_XL","content":[{"type":"text","text":"MARKER-CONTENT-42"}],"stop_reason":null,"usage":{"input_tokens":19914,"output_tokens":22,"cache_read_input_tokens":19891,"total_tokens":19936}}}`,
	result: String.raw`{"type":"result","subtype":"success","uuid":"3989bad8-f99f-467e-8a54-0cd312c59897","session_id":"6f0e1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b","is_error":false,"duration_ms":34939,"duration_api_ms":22301,"num_turns":2,"result":"MARKER-CONTENT-42","usage":{"input_tokens":100761,"output_tokens":1828,"cache_read_input_tokens":64602,"total_tokens":102589},"permission_denials":[]}`,
};
for (const [name, line] of Object.entries(raw)) lines[name] = JSON.parse(line);

describe("mapQwenLine over a real Qwen Code stream", () => {
	test("system/init maps to nothing (the session handles model/version)", () => {
		expect(mapQwenLine(lines.init, SESSION_ID)).toEqual([]);
	});

	test("every stream_event that is not a text_delta maps to nothing", () => {
		for (const name of ["goalState", "messageStart", "blockStart", "thinkingDelta", "inputJsonDelta", "blockStop", "messageStop"]) {
			expect(mapQwenLine(lines[name], SESSION_ID), name).toEqual([]);
		}
	});

	test("a text_delta surfaces as text_delta with the exact delta text", () => {
		expect(mapQwenLine(lines.textDelta, SESSION_ID)).toEqual([
			{ type: "text_delta", delta: "MARK" },
		]);
	});

	test("an assistant line holding only a thinking block maps to nothing", () => {
		expect(mapQwenLine(lines.assistantThinking, SESSION_ID)).toEqual([]);
	});

	test("an assistant tool_use line maps to tool_use with the complete input", () => {
		expect(mapQwenLine(lines.assistantToolUse, SESSION_ID)).toEqual([
			{
				type: "tool_use",
				toolName: "read_file",
				toolInput: { file_path: FILE_PATH },
				toolUseId: TOOL_ID,
			},
		]);
	});

	test("a user tool_result line maps to tool_result with the file content", () => {
		expect(mapQwenLine(lines.userToolResult, SESSION_ID)).toEqual([
			{ type: "tool_result", toolUseId: TOOL_ID, result: "MARKER-CONTENT-42\n" },
		]);
	});

	test("an assistant text line maps to one text message", () => {
		expect(mapQwenLine(lines.assistantText, SESSION_ID)).toEqual([
			{ type: "text", text: "MARKER-CONTENT-42" },
		]);
	});

	test("the result line ends the query with the final answer", () => {
		expect(mapQwenLine(lines.result, SESSION_ID)).toEqual([
			{ type: "result", sessionId: SESSION_ID, success: true, result: "MARKER-CONTENT-42", turns: 2 },
		]);
	});
});

describe("mapQwenLine edges", () => {
	test("a line from a subagent (parent_tool_use_id set) is dropped, whatever its type", () => {
		const sub = { ...lines.assistantText, parent_tool_use_id: TOOL_ID };
		const subResult = { ...lines.result, parent_tool_use_id: TOOL_ID };
		expect(mapQwenLine(sub, SESSION_ID)).toEqual([]);
		expect(mapQwenLine(subResult, SESSION_ID)).toEqual([]);
	});

	test("an assistant line with text and tool_use emits the text first, then the tool_use", () => {
		const line: Record<string, unknown> = {
			type: "assistant",
			session_id: SESSION_ID,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading the marker file." },
					{ type: "tool_use", id: TOOL_ID, name: "read_file", input: { file_path: FILE_PATH } },
				],
			},
		};
		expect(mapQwenLine(line, SESSION_ID)).toEqual([
			{ type: "text", text: "Reading the marker file." },
			{ type: "tool_use", toolName: "read_file", toolInput: { file_path: FILE_PATH }, toolUseId: TOOL_ID },
		]);
	});

	test("a tool_result whose content is a block array joins its text blocks", () => {
		const line: Record<string, unknown> = {
			type: "user",
			session_id: SESSION_ID,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: TOOL_ID,
						is_error: false,
						content: [
							{ type: "text", text: "first line" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
							{ type: "text", text: "second line" },
						],
					},
				],
			},
		};
		expect(mapQwenLine(line, SESSION_ID)).toEqual([
			{ type: "tool_result", toolUseId: TOOL_ID, result: "first line\nsecond line" },
		]);
	});

	test("an errored tool_result is prefixed [Error] ", () => {
		const line: Record<string, unknown> = {
			type: "user",
			session_id: SESSION_ID,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: TOOL_ID, is_error: true, content: "File not found: /nope" }],
			},
		};
		expect(mapQwenLine(line, SESSION_ID)).toEqual([
			{ type: "tool_result", toolUseId: TOOL_ID, result: "[Error] File not found: /nope" },
		]);
	});

	test("an errored tool_result with no content names the failure", () => {
		const line: Record<string, unknown> = {
			type: "user",
			session_id: SESSION_ID,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: TOOL_ID, is_error: true, content: null }],
			},
		};
		expect(mapQwenLine(line, SESSION_ID)).toEqual([
			{ type: "tool_result", toolUseId: TOOL_ID, result: "[Error] Tool execution failed" },
		]);
	});

	test("a failed result reports success: false", () => {
		const line = { ...lines.result, is_error: true, subtype: "error_max_turns" };
		expect(mapQwenLine(line, SESSION_ID)).toEqual([
			{ type: "result", sessionId: SESSION_ID, success: false, result: "MARKER-CONTENT-42", turns: 2 },
		]);
	});

	test("a result without session_id falls back to the session's own id", () => {
		const { session_id: _omit, ...noId } = lines.result as Record<string, unknown>;
		expect(mapQwenLine(noId, "fallback-session")).toEqual([
			{ type: "result", sessionId: "fallback-session", success: true, result: "MARKER-CONTENT-42", turns: 2 },
		]);
	});

	test("an unknown top-level type maps to nothing", () => {
		expect(mapQwenLine({ type: "mcp_status", servers: [] }, SESSION_ID)).toEqual([]);
		expect(mapQwenLine({}, SESSION_ID)).toEqual([]);
	});

	test("a content_block_delta whose delta is not a text_delta maps to nothing", () => {
		const line = {
			type: "stream_event",
			session_id: SESSION_ID,
			event: { type: "content_block_delta", delta: { type: "text_delta" } },
		};
		expect(mapQwenLine(line, SESSION_ID)).toEqual([]);
	});
});
