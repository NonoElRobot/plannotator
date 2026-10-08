/**
 * Qwen Code SDK provider — Node.js variant.
 *
 * Identical to qwen-sdk.ts except QwenProcessNode uses child_process.spawn()
 * instead of Bun.spawn(). Everything else (provider, session, event mapping)
 * is duplicated here the way pi-sdk-node.ts duplicates pi-sdk.ts, because a
 * Node runtime cannot import a module that references Bun globals.
 *
 * Used by the Pi extension's server, which runs under Node.
 */

import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
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
import { registerProviderFactory } from "../provider.ts";
import {
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";
import { guardChildStreams, writeChildLine } from "./child-io.ts";

// Re-export mapQwenLine from shared (runtime-agnostic)
export { mapQwenLine } from "./qwen-events.ts";

const PROVIDER_NAME = "qwen-sdk";
const QWEN_PROCESS_LABEL = "Qwen process";

/**
 * Wall-clock budget for a one-shot run. A hung or pathologically slow model
 * call aborts at this budget with exit 55 instead of stalling the chat
 * forever. 10m matches Qwen Code's own CI recommendation.
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
// One-shot subprocess wrapper (Node.js)
// ---------------------------------------------------------------------------

type LineListener = (line: Record<string, unknown>) => void;
type ExitListener = (code: number | null) => void;

/** Exported for the stdio-failure regression tests (#1378 pattern). */
export class QwenProcessNode {
	private proc: ChildProcess | null = null;
	private lineListeners = new Set<LineListener>();
	private exitListeners = new Set<ExitListener>();
	private buffer = "";
	private ended = false;
	private stderrTail = "";

	/** Bounded stderr tail (last ~4 KB), for surfacing real failures. */
	get stderr(): string {
		return this.stderrTail;
	}

	/**
	 * Start the run. The prompt goes on STDIN (written and closed): argv is
	 * capped at ~8 KB under cmd.exe and the first query carries the whole
	 * review preamble.
	 */
	async spawn(qwenPath: string, cwd: string, prompt: string, args: string[]): Promise<void> {
		const commandPath = resolveWindowsCommandShim(qwenPath);
		// Spawn the program DIRECTLY — no `cmd /d /s /c` wrapper (see qwen-sdk.ts
		// for why the wrapped form is corrupted on Windows).
		const command = [commandPath, ...args];
		let proc: ChildProcess;
		try {
			const [file, ...rest] = command;
			// stderr is a pipe we drain (data listener below) into a bounded
			// tail for diagnostics; draining keeps the pipe from filling and
			// deadlocking the child.
			proc = spawn(file, rest, {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.handleExit(null);
			throw error;
		}

		this.proc = proc;
		// Cover every pipe BEFORE the spawn handshake: an `error` event on a
		// child stream with no listener becomes an uncaughtException and kills
		// the host agent process, not just this provider (#1378).
		guardChildStreams(proc, QWEN_PROCESS_LABEL, (error) => this.failProcess(error));
		// Bounded stderr tail for diagnostics; this data listener is what keeps
		// the pipe drained so the child never deadlocks on a full buffer.
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail += chunk.toString();
			if (this.stderrTail.length > 4000) {
				this.stderrTail = this.stderrTail.slice(-4000);
			}
		});
		proc.once("exit", (code) => this.handleExit(code));

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				proc.off("spawn", onSpawn);
				proc.off("error", onError);
			};
			const onSpawn = () => {
				cleanup();
				this.readStream();
				resolve();
			};
			const onError = (err: Error) => {
				cleanup();
				this.handleExit(null);
				reject(err);
			};

			proc.once("spawn", onSpawn);
			proc.once("error", onError);
		});

		// A closed or broken stdin is a provider failure, never a throw at the
		// caller and never an unhandled stream error (see writeChildLine).
		const stdinError = writeChildLine(
			this.proc,
			prompt,
			QWEN_PROCESS_LABEL,
			(err) => this.failProcess(err),
		);
		if (stdinError) {
			this.failProcess(stdinError);
			throw stdinError;
		}
		try {
			proc.stdin?.end();
		} catch (err) {
			this.failProcess(err instanceof Error ? err : new Error(String(err)));
			throw err instanceof Error ? err : new Error(String(err));
		}
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

	/**
	 * A pipe to the child broke. Resolve it as a provider failure: tell
	 * listeners the process ended and reap the child so it cannot linger.
	 * `ended` flips true, so the later exit event is a no-op.
	 */
	private failProcess(error: Error): void {
		const proc = this.proc;
		this.handleExit(null);
		if (proc) {
			try {
				if (!killWindowsProcessTree(proc.pid)) proc.kill();
			} catch {
				// Already gone.
			}
		}
	}

	private handleExit(code: number | null): void {
		if (this.ended) return;
		this.ended = true;
		this.proc = null;
		for (const listener of this.exitListeners) listener(code);
	}

	private readStream(): void {
		if (!this.proc?.stdout) return;

		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.replace(/\r$/, "");
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed);
					this.emitLine(parsed);
				} catch {
					// Ignore malformed lines
				}
			}
		});
	}

	private emitLine(line: Record<string, unknown>): void {
		for (const listener of this.lineListeners) listener(line);
	}

	kill(): void {
		const proc = this.proc;
		this.proc = null;
		if (proc) {
			try {
				if (!killWindowsProcessTree(proc.pid)) proc.kill();
			} catch {
				// Already gone.
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Provider (identical to qwen-sdk.ts, using QwenProcessNode)
// ---------------------------------------------------------------------------

export class QwenSDKNodeProvider implements AIProvider {
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
	private sessions = new Map<string, QwenSDKNodeSession>();
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

	async createSession(options: CreateSessionOptions): Promise<QwenSDKNodeSession> {
		const session = new QwenSDKNodeSession({
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

	async resumeSession(sessionId: string): Promise<QwenSDKNodeSession> {
		// The session id IS the qwen session id (a UUIDv4 we chose), so no
		// Plannotator-side state is needed to resume: the next query
		// re-spawns with --resume into the stored conversation. The preamble
		// is not re-injected — it is already in the first message.
		const session = new QwenSDKNodeSession(
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
			const raw = await readFile(join(baseDir, "settings.json"), "utf8");
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
// Session (identical to qwen-sdk.ts, using QwenProcessNode)
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

class QwenSDKNodeSession extends BaseSession {
	private config: SessionConfig;
	private process: QwenProcessNode | null = null;
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
		const { mapQwenLine } = await import("./qwen-events.ts");

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

		const process = new QwenProcessNode();
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
			await process.spawn(
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
// Factory registration
// ---------------------------------------------------------------------------

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new QwenSDKNodeProvider(config as QwenSDKConfig),
);
