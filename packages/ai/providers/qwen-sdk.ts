/**
 * Qwen Code SDK provider — bridges Plannotator's AI layer with the Qwen Code
 * CLI.
 *
 * One short-lived `qwen` process per query (headless one-shot), not a
 * long-lived RPC channel: `qwen -o stream-json` answers a single prompt and
 * exits. The prompt goes on STDIN, not argv: cmd.exe caps an argument list at
 * ~8 KB while the first query carries the whole review preamble (up to 60 KB),
 * so `--append-system-prompt` is not an option; the preamble is inlined into
 * the first query's prompt via buildEffectivePrompt, the house pattern Codex
 * and Pi use.
 *
 * Conversation continuity is Qwen Code's own: the session id (our UUIDv4) is
 * passed as `--session-id` on the first query and `--resume <id>` on later
 * ones, so each query re-spawns into the same stored conversation.
 *
 * `--approval-mode plan` makes the run read-only (analyze, never modify),
 * which is exactly what Ask AI needs; `--max-session-turns` bounds the turn
 * count and `--max-wall-time` bounds the whole run, so a hung or
 * pathologically slow model call aborts with exit code 55 instead of stalling
 * the chat forever.
 *
 * The user must have the `qwen` CLI installed (qwen-code.ai).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { qwenCatalogFromSettings, type CatalogModel } from "@plannotator/core/model-catalog";
import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	QwenSDKConfig,
} from "../types.ts";
import {
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";
import { mapQwenLine } from "./qwen-events.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "qwen-sdk";

/**
 * Wall-clock budget for a one-shot run. A hung or pathologically slow model
 * call (a slow local model plus a large always-on context can take minutes to
 * first token) aborts at this budget with exit 55 instead of stalling the
 * chat forever. 10m matches Qwen Code's own CI recommendation.
 */
const QWEN_MAX_WALL_TIME = "10m";

/**
 * A qwen exit without a result line. 55 is the CLI's wall-time budget abort.
 * The bounded stderr tail (if any) is appended so a real failure — e.g. the
 * model server being down — reaches the reviewer instead of a bare code.
 */
function qwenExitError(code: number | null, stderrTail?: string): string {
	let message: string;
	if (code === 55) {
		message =
			"Qwen Code aborted the run: its wall-time budget was exceeded (exit code 55).";
	} else if (code == null) {
		message = "Qwen process ended without producing a result.";
	} else {
		message = `Qwen process exited with code ${code} before producing a result.`;
	}
	const tail = stderrTail?.trim();
	if (tail) message += ` Stderr: ${tail.slice(-500)}`;
	return message;
}

// ---------------------------------------------------------------------------
// One-shot subprocess wrapper
// ---------------------------------------------------------------------------

type LineListener = (line: Record<string, unknown>) => void;
type ExitListener = (code: number | null) => void;

class QwenProcess {
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private buffer = "";
	private lineListeners = new Set<LineListener>();
	private exitListeners = new Set<ExitListener>();
	private exited = false;
	private stderrTail = "";

	/**
	 * Start the run. The prompt goes on STDIN (written and closed): argv is
	 * capped at ~8 KB under cmd.exe and the first query carries the whole
	 * review preamble.
	 */
	spawn(qwenPath: string, cwd: string, prompt: string, args: string[]): void {
		const commandPath = resolveWindowsCommandShim(qwenPath);
		// Spawn the program DIRECTLY — no `cmd /d /s /c` wrapper. CreateProcess
		// executes a `.cmd`/`.bat` shim natively (it parses the batch file),
		// whereas wrapping it makes the runtime re-quote the command string and
		// corrupt the program path: the child died in <1 s with exit 1,
		// "'qwen.cmd' is not recognized" (verified with qwen 0.25.0 on Windows).
		const command = [commandPath, ...args];
		try {
			// stdin is an ArrayBufferView, not a string (the SpawnOptions
			// type takes no string): the child reads the buffer, then hits
			// EOF — the exact transport a shell redirect gives.
			// stderr is a pipe we fully drain into a bounded tail (see
			// drainStderr) for diagnostics; draining keeps the pipe from
			// filling and deadlocking the child.
			this.proc = Bun.spawn(command, {
				cwd,
				stdin: new TextEncoder().encode(prompt),
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.handleExit(null);
			throw error;
		}
		this.readStream();
		this.drainStderr();
		void this.proc.exited.then((code) => this.handleExit(code));
	}

	/** Bounded stderr tail (last ~4 KB), for surfacing real failures. */
	get stderr(): string {
		return this.stderrTail;
	}

	/**
	 * Drain stderr into a bounded tail. It MUST be fully drained or the pipe
	 * fills and the child deadlocks; the IIFE swallows close errors.
	 */
	private drainStderr(): void {
		if (!this.proc?.stderr || typeof this.proc.stderr === "number") return;
		const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		void (async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					this.stderrTail += decoder.decode(value, { stream: true });
					if (this.stderrTail.length > 4000) {
						this.stderrTail = this.stderrTail.slice(-4000);
					}
				}
			} catch {
				// Stream closed.
			}
		})();
	}

	onLine(listener: LineListener): () => void {
		this.lineListeners.add(listener);
		return () => {
			this.lineListeners.delete(listener);
		};
	}

	onExit(listener: ExitListener): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	private handleExit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of this.exitListeners) listener(code);
	}

	private async readStream(): Promise<void> {
		if (!this.proc?.stdout || typeof this.proc.stdout === "number") return;
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				this.buffer += decoder.decode(value, { stream: true });
				const lines = this.buffer.split("\n");
				this.buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.replace(/\r$/, "");
					if (!trimmed) continue;
					try {
						this.emitLine(JSON.parse(trimmed));
					} catch {
						// Ignore malformed lines
					}
				}
			}
			// A final line without a trailing newline
			const tail = this.buffer.replace(/\r$/, "");
			if (tail) {
				try {
					this.emitLine(JSON.parse(tail));
				} catch {
					// Ignore malformed tail
				}
			}
		} catch {
			// Stream closed
		}
	}

	private emitLine(line: Record<string, unknown>): void {
		for (const listener of this.lineListeners) listener(line);
	}

	kill(): void {
		const proc = this.proc;
		this.proc = null;
		if (proc && !this.exited) {
			try {
				if (!killWindowsProcessTree(proc.pid)) proc.kill();
			} catch {
				// Already gone.
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class QwenSDKProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: false,
		resume: true,
		streaming: true,
		tools: true,
	};
	models?: CatalogModel[];
	modelsSource?: "fallback" | "discovered";

	private config: QwenSDKConfig;
	private sessions = new Map<string, QwenSDKSession>();
	private _toolVersion: string | undefined;

	/**
	 * The installed qwen's version, once a first query's init line has
	 * reported it (discovery reads settings.json and does not spawn).
	 */
	get toolVersion(): string | undefined {
		return this._toolVersion;
	}

	constructor(config: QwenSDKConfig) {
		this.config = config;
	}

	private captureInit(info: { model?: string; version?: string }): void {
		if (info.version && !this._toolVersion) this._toolVersion = info.version;
	}

	async createSession(options: CreateSessionOptions): Promise<QwenSDKSession> {
		const session = new QwenSDKSession({
			systemPrompt: buildSystemPrompt(options.context),
			cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			qwenExecutablePath: this.config.qwenExecutablePath ?? "qwen",
			model: options.model ?? this.config.model,
			maxTurns: options.maxTurns,
			resume: false,
			onInit: (info) => this.captureInit(info),
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(): Promise<never> {
		throw new Error(
			"Qwen Code does not support session forking. " +
				"The endpoint layer should fall back to createSession().",
		);
	}

	async resumeSession(sessionId: string): Promise<QwenSDKSession> {
		// The session id IS the qwen session id (a UUIDv4 we chose), so no
		// Plannotator-side state is needed to resume: the next query
		// re-spawns with --resume into the stored conversation. The preamble
		// is not re-injected — it is already in the first message.
		const session = new QwenSDKSession(
			{
				systemPrompt: "",
				cwd: this.config.cwd ?? process.cwd(),
				parentSessionId: null,
				qwenExecutablePath: this.config.qwenExecutablePath ?? "qwen",
				resume: true,
				onInit: (info) => this.captureInit(info),
			},
			sessionId,
		);
		this.sessions.set(session.id, session);
		return session;
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			session.killProcess();
		}
		this.sessions.clear();
	}

	/**
	 * Fetch available models from the qwen CLI's own `settings.json`
	 * (no probe process). Call before registering the provider.
	 */
	async fetchModels(): Promise<void> {
		try {
			const baseDir = process.env.QWEN_HOME?.trim() || join(homedir(), ".qwen");
			const raw = await Bun.file(join(baseDir, "settings.json")).text();
			const models = qwenCatalogFromSettings(JSON.parse(raw));
			if (models.length > 0) {
				this.models = models;
				this.modelsSource = "discovered";
			}
		} catch {
			// No settings.json or no models configured: the picker stays
			// empty and a session runs on the qwen CLI's own default model.
		}
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
	systemPrompt: string;
	cwd: string;
	parentSessionId: string | null;
	qwenExecutablePath: string;
	model?: string;
	maxTurns?: number;
	/** True for resumeSession(): the conversation already exists in qwen's store. */
	resume: boolean;
	/** Called with the init line's model and CLI version. */
	onInit: (info: { model?: string; version?: string }) => void;
}

class QwenSDKSession extends BaseSession {
	private config: SessionConfig;
	private process: QwenProcess | null = null;
	/**
	 * Set by our own abort(). BaseSession.abort() clears its own controller,
	 * so it alone cannot tell a later exit handler that the exit was ours
	 * (an aborted run must not surface a process-exit error). Reset on every
	 * query.
	 */
	private abortRequested = false;

	constructor(config: SessionConfig, initialId?: string) {
		super({
			parentSessionId: config.parentSessionId,
			...(initialId ? { initialId } : {}),
		});
		this.config = config;
	}

	private buildArgs(firstQuery: boolean): string[] {
		const args: string[] = [
			// --session-id requires a real UUIDv4: our id is one, since the
			// first query.
			firstQuery && !this.config.resume ? "--session-id" : "--resume",
			this.id,
			"-o",
			"stream-json",
			"--include-partial-messages",
			"--approval-mode",
			"plan",
			// Bound the whole run: a hung / pathologically slow model call
			// aborts with exit 55 instead of stalling the chat forever.
			"--max-wall-time",
			QWEN_MAX_WALL_TIME,
		];
		if (this.config.model) args.push("-m", this.config.model);
		if (this.config.maxTurns && this.config.maxTurns > 0) {
			args.push("--max-session-turns", String(this.config.maxTurns));
		}
		return args;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen } = started;
		this.abortRequested = false;
		const firstQuery = !this._firstQuerySent;

		// Async queue bridging callback events → async iterable
		const queue: AIMessage[] = [];
		let resolve: (() => void) | null = null;
		let done = false;
		let sawResult = false;

		const push = (msg: AIMessage) => {
			queue.push(msg);
			resolve?.();
		};
		const finish = () => {
			done = true;
			resolve?.();
		};

		const onLine = (line: Record<string, unknown>) => {
			// The init line carries the model and the CLI version (the
			// provider's toolVersion); it is not chat content.
			if (line.type === "system" && line.subtype === "init") {
				this.config.onInit({
					...(typeof line.model === "string" ? { model: line.model } : {}),
					...(typeof line.qwen_code_version === "string"
						? { version: line.qwen_code_version }
						: {}),
				});
				return;
			}
			for (const msg of mapQwenLine(line, this.id)) {
				if (msg.type === "result") sawResult = true;
				push(msg);
				if (msg.type === "result") finish();
			}
		};

		const onExit = (code: number | null) => {
			if (done) return;
			if (!sawResult && !this.abortRequested) {
				push({
					type: "error",
					error: qwenExitError(code, process.stderr),
					code: "qwen_process_exit",
				});
			}
			finish();
		};

		const process = new QwenProcess();
		// Register before spawn: lines start flowing as soon as the child
		// writes its init line.
		const unsubscribeLine = process.onLine(onLine);
		const unsubscribeExit = process.onExit(onExit);
		this.process = process;

		// Prepend the system prompt on the first query only (the preamble is
		// already in the conversation after that — and in the stored
		// conversation of a resumed session).
		const effectivePrompt = buildEffectivePrompt(
			prompt,
			this.config.systemPrompt,
			this._firstQuerySent,
		);

		try {
			process.spawn(
				this.config.qwenExecutablePath,
				this.config.cwd,
				effectivePrompt,
				this.buildArgs(firstQuery),
			);
		} catch (err) {
			unsubscribeLine();
			unsubscribeExit();
			yield {
				type: "error",
				error: `Failed to start qwen: ${err instanceof Error ? err.message : String(err)}`,
				code: "qwen_spawn_error",
			};
			return;
		}
		this._firstQuerySent = true;

		// Drain queue
		try {
			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise<void>((r) => {
						resolve = r;
					});
					resolve = null;
				}
			}
		} catch (err) {
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
				code: "provider_error",
			};
		} finally {
			unsubscribeLine();
			unsubscribeExit();
			// The one-shot may linger after its result line instead of exiting
			// (notably with MCP servers loaded), so reap it: every query must
			// leave no process behind. A no-op once the child has exited.
			process.kill();
		}

		this.endQuery(gen);
	}

	abort(): void {
		this.abortRequested = true;
		this.process?.kill();
		super.abort();
	}

	/** Kill the current process. Called by the provider on dispose. */
	killProcess(): void {
		this.process?.kill();
		this.process = null;
	}
}

// ---------------------------------------------------------------------------
// Event mapping — shared with qwen-sdk-node.ts
// ---------------------------------------------------------------------------

export { mapQwenLine } from "./qwen-events.ts";

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new QwenSDKProvider(config as QwenSDKConfig),
);
