/**
 * Qwen Code Session Log Resolver
 *
 * Used by the "annotate-last" feature to let users annotate the most recent
 * assistant response of a Qwen Code session in the annotation UI.
 *
 * Qwen Code records each session at:
 *   <runtime base>/projects/<sanitized-cwd>/chats/<session-id>.jsonl
 *
 * where the runtime base is $QWEN_RUNTIME_DIR, else $QWEN_HOME, else
 * ~/.qwen (mirrors Qwen's Storage). Qwen sets two process env vars at
 * session start that every child (hooks, shell commands) inherits:
 *   QWEN_CODE_PROJECT_DIR = <runtime base>/projects/<sanitized-cwd>
 *   QWEN_CODE_SESSION_ID  = <session id>
 *
 * Line shape (Gemini-style): each line is a JSON object with `uuid`, `type`
 * ("user" | "assistant" | "tool_result" | "system"), `timestamp` and
 * `message.parts`. A rendered assistant line has type "assistant"; its parts
 * are { text, thought? } or { functionCall }, and parts marked
 * `thought` are reasoning, not rendered text. Subagent runs are recorded to
 * sidecar files (agent-<id>.jsonl under the project dir), so the main log
 * carries only the main conversation.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RenderedMessage } from "./session-log";

/**
 * Derive Qwen's project directory name from a cwd: lowercased on Windows,
 * every character outside [a-zA-Z0-9] replaced with `-` (mirrors Qwen's
 * sanitizeCwd).
 */
export function sanitizeQwenCwd(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
}

function expandHome(p: string | undefined): string | undefined {
  const trimmed = p?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Resolve the directory holding Qwen's per-project session directories
 * (each containing a `chats/` folder). Mirrors Qwen's Storage:
 * $QWEN_RUNTIME_DIR > $QWEN_HOME > ~/.qwen, with the projects dir under it.
 */
export function getQwenProjectsDir(
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  const env = opts.env ?? process.env;
  const base = expandHome(env.QWEN_RUNTIME_DIR) ?? expandHome(env.QWEN_HOME);
  return join(base ?? join(homedir(), ".qwen"), "projects");
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== "." &&
    value !== ".."
  );
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function newestChatLog(chatsDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(chatsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: string | null = null;
  let newestMtime = -1;
  for (const f of files) {
    const full = join(chatsDir, f);
    try {
      const mtime = statSync(full).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newest = full;
      }
    } catch {
      // File disappeared between readdir and stat — skip
    }
  }
  return newest;
}

export interface QwenSessionLogOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seam: replaces the resolved projects directory. */
  projectsDir?: string;
}

/**
 * Resolve the JSONL session log for the current Qwen Code session.
 *
 * Prefers the env vars Qwen sets at session start
 * (QWEN_CODE_PROJECT_DIR + QWEN_CODE_SESSION_ID), which name the log
 * directly. When either is missing or the named log does not exist, falls
 * back to the newest chat of the sanitized project dir of the calling cwd
 * (the CLI runs in the session's directory when invoked from its shell).
 */
export function findQwenSessionLog(
  opts: QwenSessionLogOptions = {},
): string | null {
  const env = opts.env ?? process.env;

  const projectDir = env.QWEN_CODE_PROJECT_DIR?.trim();
  const sessionId = env.QWEN_CODE_SESSION_ID?.trim();
  if (projectDir && sessionId && isSafePathSegment(sessionId)) {
    const candidate = join(projectDir, "chats", `${sessionId}.jsonl`);
    if (isReadableFile(candidate)) return candidate;
  }

  const cwd = opts.cwd ?? process.cwd();
  const chatsDir = join(
    opts.projectsDir ?? getQwenProjectsDir({ env }),
    sanitizeQwenCwd(cwd),
    "chats",
  );
  return newestChatLog(chatsDir);
}

interface QwenLogPart {
  text?: unknown;
  thought?: unknown;
  [key: string]: unknown;
}

interface QwenLogLine {
  uuid?: unknown;
  type?: unknown;
  timestamp?: unknown;
  message?: { parts?: unknown };
}

/**
 * Extract up to `limit` of the most recent rendered assistant messages from
 * a Qwen session log, newest-first.
 *
 * A rendered message is a type "assistant" line with at least one non-empty
 * text part that is not marked `thought` (reasoning). Lines carrying only
 * functionCall parts (a pure tool-call turn) are skipped, as are malformed
 * lines. Each assistant line is a complete message (one line per model
 * response), so no cross-line chunk merging is needed.
 */
export function getRecentQwenMessages(
  logPath: string,
  limit: number,
): RenderedMessage[] {
  if (limit <= 0) return [];
  let lines: string[];
  try {
    lines = readFileSync(logPath, "utf-8").split("\n");
  } catch {
    return [];
  }

  const out: RenderedMessage[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: QwenLogLine;
    try {
      entry = JSON.parse(line) as QwenLogLine;
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const parts = entry.message?.parts;
    if (!Array.isArray(parts)) continue;

    const texts: string[] = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const part = p as QwenLogPart;
      if (part.thought) continue;
      if (typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
    if (texts.length === 0) continue;

    out.push({
      messageId:
        typeof entry.uuid === "string" && entry.uuid
          ? entry.uuid
          : `qwen-line-${i + 1}`,
      text: texts.join("\n"),
      lineNumbers: [i + 1],
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    });
  }
  return out;
}

/** Convenience: the single most recent rendered assistant message in a Qwen log. */
export function getLastQwenRenderedMessage(
  logPath: string,
): RenderedMessage | null {
  return getRecentQwenMessages(logPath, 1)[0] ?? null;
}
