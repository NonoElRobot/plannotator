/**
 * Qwen Code Session Log Tests
 *
 * Run: bun test apps/hook/server/qwen-session.test.ts
 *
 * Uses synthetic fixtures matching Qwen Code's session layout:
 *   <projects>/<sanitized-cwd>/chats/<session-id>.jsonl
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  sanitizeQwenCwd,
  getQwenProjectsDir,
  findQwenSessionLog,
  getRecentQwenMessages,
  getLastQwenRenderedMessage,
} from "./qwen-session";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProjectsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "qwen-projects-"));
  tempDirs.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Write a chat log under <projectsDir>/<slug>/chats/<name> and return its path. */
function writeChatLog(projectsDir: string, slug: string, name: string, content: string): string {
  const chatsDir = join(projectsDir, slug, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const path = join(chatsDir, name);
  writeFileSync(path, content);
  return path;
}

function assistantLine(
  uuid: string,
  parts: Record<string, unknown>[],
  timestamp?: string,
): string {
  return JSON.stringify({
    uuid,
    sessionId: "sess-1",
    timestamp: timestamp ?? "2026-10-07T21:26:34.260Z",
    type: "assistant",
    provenance: "assistant_output",
    message: { role: "model", parts },
  });
}

describe("sanitizeQwenCwd", () => {
  test("Windows: lowercases and replaces every non-alphanumeric character", () => {
    expect(
      sanitizeQwenCwd("C:\\Users\\Nono\\AppData\\Local\\Temp\\plannotator-qwen-test\\project", "win32"),
    ).toBe("c--users-nono-appdata-local-temp-plannotator-qwen-test-project");
    expect(sanitizeQwenCwd("E:\\Github\\plannotator", "win32")).toBe("e--github-plannotator");
  });

  test("POSIX: replaces characters but preserves case", () => {
    expect(sanitizeQwenCwd("/Users/NONO/proj", "linux")).toBe("-Users-NONO-proj");
  });
});

describe("getQwenProjectsDir", () => {
  test("QWEN_RUNTIME_DIR wins", () => {
    const root = makeProjectsDir();
    const rt = join(root, "runtime");
    const home = join(root, "home");
    expect(getQwenProjectsDir({ env: { QWEN_RUNTIME_DIR: rt, QWEN_HOME: home } })).toBe(
      join(rt, "projects"),
    );
  });

  test("falls back to QWEN_HOME", () => {
    const root = makeProjectsDir();
    const home = join(root, "home");
    expect(getQwenProjectsDir({ env: { QWEN_HOME: home } })).toBe(join(home, "projects"));
  });

  test("defaults to ~/.qwen/projects", () => {
    expect(getQwenProjectsDir({ env: {} })).toBe(join(homedir(), ".qwen", "projects"));
  });
});

describe("findQwenSessionLog", () => {
  test("addresses the log directly from the session env vars", () => {
    const projectsDir = makeProjectsDir();
    const slug = "c--users-nono-project";
    const log = writeChatLog(projectsDir, slug, "abc-123.jsonl", assistantLine("u1", [{ text: "hi" }]));
    const found = findQwenSessionLog({
      env: {
        QWEN_CODE_PROJECT_DIR: join(projectsDir, slug),
        QWEN_CODE_SESSION_ID: "abc-123",
      },
      cwd: "irrelevant",
    });
    expect(found).toBe(log);
  });

  test("a missing named log falls back to the newest chat of the cwd project", () => {
    const projectsDir = makeProjectsDir();
    const slug = "c--users-nono-project";
    const old = writeChatLog(projectsDir, slug, "old.jsonl", assistantLine("u1", [{ text: "old" }]));
    utimesSync(old, 100, 100);
    const fresh = writeChatLog(projectsDir, slug, "fresh.jsonl", assistantLine("u2", [{ text: "new" }]));
    utimesSync(fresh, 200, 200);
    const found = findQwenSessionLog({
      env: {
        QWEN_CODE_PROJECT_DIR: join(projectsDir, slug),
        QWEN_CODE_SESSION_ID: "does-not-exist",
      },
      cwd: "C:\\Users\\Nono\\Project",
      projectsDir,
    });
    expect(found).toBe(fresh);
  });

  test("without env vars, picks the newest chat of the sanitized cwd project", () => {
    const projectsDir = makeProjectsDir();
    const slug = "e--github-plannotator";
    const a = writeChatLog(projectsDir, slug, "a.jsonl", assistantLine("u1", [{ text: "a" }]));
    utimesSync(a, 100, 100);
    const b = writeChatLog(projectsDir, slug, "b.jsonl", assistantLine("u2", [{ text: "b" }]));
    utimesSync(b, 200, 200);
    const found = findQwenSessionLog({
      env: {},
      cwd: "E:\\Github\\plannotator",
      projectsDir,
    });
    expect(found).toBe(b);
  });

  test("a path-shaped session id never escapes the chats dir", () => {
    const projectsDir = makeProjectsDir();
    const slug = "e--github-plannotator";
    const a = writeChatLog(projectsDir, slug, "a.jsonl", assistantLine("u1", [{ text: "a" }]));
    const found = findQwenSessionLog({
      env: {
        QWEN_CODE_PROJECT_DIR: join(projectsDir, slug),
        QWEN_CODE_SESSION_ID: "..\\..\\evil",
      },
      cwd: "E:\\Github\\plannotator",
      projectsDir,
    });
    expect(found).toBe(a);
  });

  test("returns null when no chat exists", () => {
    const projectsDir = makeProjectsDir();
    expect(
      findQwenSessionLog({ env: {}, cwd: "E:\\Github\\nowhere", projectsDir }),
    ).toBeNull();
  });
});

describe("getRecentQwenMessages", () => {
  function writeLog(...lines: string[]): string {
    const projectsDir = makeProjectsDir();
    const log = writeChatLog(projectsDir, "p", "s.jsonl", lines.join("\n") + "\n");
    return log;
  }

  test("returns assistant text newest-first, skipping thoughts, tool calls and noise", () => {
    const log = writeLog(
      JSON.stringify({ uuid: "u0", type: "user", message: { role: "user", parts: [{ text: "prompt" }] } }),
      assistantLine("a1", [
        { text: "thinking...", thought: true },
        { text: "First answer." },
        { functionCall: { id: "c1", name: "run_shell_command", args: {} } },
      ], "2026-10-07T21:00:00.000Z"),
      "not json {",
      JSON.stringify({ uuid: "s1", type: "system", subtype: "ui_telemetry", systemPayload: {} }),
      assistantLine("a2", [
        { functionCall: { id: "c2", name: "run_shell_command", args: {} } },
      ], "2026-10-07T21:05:00.000Z"),
      assistantLine("a3", [
        { text: "Still thinking", thought: true },
      ], "2026-10-07T21:06:00.000Z"),
      assistantLine("a4", [{ text: "Last answer." }], "2026-10-07T21:10:00.000Z"),
    );
    const recent = getRecentQwenMessages(log, 25);
    expect(recent.map((m) => m.messageId)).toEqual(["a4", "a1"]);
    expect(recent[0].text).toBe("Last answer.");
    expect(recent[0].timestamp).toBe("2026-10-07T21:10:00.000Z");
    expect(recent[1].text).toBe("First answer.");
  });

  test("joins multiple text parts of one line", () => {
    const log = writeLog(
      assistantLine("a1", [{ text: "part one" }, { text: "part two" }]),
    );
    expect(getRecentQwenMessages(log, 1)[0].text).toBe("part one\npart two");
  });

  test("honors the limit and returns nothing for an empty log", () => {
    const log = writeLog(
      assistantLine("a1", [{ text: "one" }]),
      assistantLine("a2", [{ text: "two" }]),
      assistantLine("a3", [{ text: "three" }]),
    );
    expect(getRecentQwenMessages(log, 2).map((m) => m.messageId)).toEqual(["a3", "a2"]);
    expect(getRecentQwenMessages(log, 0)).toEqual([]);
    const empty = makeProjectsDir();
    const path = join(empty, "s.jsonl");
    writeFileSync(path, "");
    expect(getRecentQwenMessages(path, 5)).toEqual([]);
  });
});

describe("getLastQwenRenderedMessage", () => {
  test("returns the most recent rendered message or null", () => {
    const projectsDir = makeProjectsDir();
    const log = writeChatLog(
      projectsDir,
      "p",
      "s.jsonl",
      assistantLine("a1", [{ text: "old" }]) + "\n",
    );
    expect(getLastQwenRenderedMessage(log)?.text).toBe("old");
    expect(getLastQwenRenderedMessage(join(projectsDir, "missing.jsonl"))).toBeNull();
  });
});
