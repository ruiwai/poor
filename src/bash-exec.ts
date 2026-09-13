import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { Type } from "typebox";
import { CommandArtifacts } from "./command-artifacts.ts";

export const BASH_LIMITS = Object.freeze({
  maxCommandBytes: 131_072,
  defaultCommandSeconds: 120,
  maxCommandSeconds: 604_800,
  maxArtifactBytes: 67_108_864,
  maxPreviewBytes: 67_108_864,
  defaultPreviewBytes: 1_024,
  terminationGraceMs: 200,
  collectorSettleMs: 2_000,
});

const optionalInteger = (max: number, description: string) => Type.Optional(Type.Union([
  Type.Integer({ minimum: 1, maximum: max, description }), Type.Null(),
]));
export const bashParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: BASH_LIMITS.maxCommandBytes,
    description: "Fresh non-interactive bash -c command. Runtime limit is UTF-8 bytes." }),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, default: ".",
    description: "Initial host directory; relative paths resolve from the Pi session cwd. Not a shell sandbox." })),
  // The schema and runtime use the same 64 MiB per-stream cap.
  timeout_seconds: optionalInteger(BASH_LIMITS.maxCommandSeconds, "Execution deadline; effective local default 120 seconds and maximum 7 days."),
  max_artifact_bytes: optionalInteger(BASH_LIMITS.maxArtifactBytes, "Per-stream retained prefix quota; default and maximum 64 MiB."),
  max_preview_bytes: optionalInteger(BASH_LIMITS.maxPreviewBytes, "Per-stream raw preview quota; default 1024; must not exceed max_artifact_bytes."),
}, { additionalProperties: false });

export interface BashExecArguments {
  command: string;
  cwd?: string;
  timeout_seconds?: number | null;
  max_artifact_bytes?: number | null;
  max_preview_bytes?: number | null;
}
export interface OutputStream {
  /** Present only when the captured prefix does not fit in preview. */
  path?: string;
  preview: string;
  /** Bytes shown inline / bytes observed on the stream. */
  len: string;
}
export interface BashExecResult {
  cwd: string;
  outcome: {
    command_id: string;
    exit_code: number | null;
    signal: number | null;
    timed_out: boolean;
    descendant_cleanup_attempted: boolean;
    duration_ms: number;
    stdout: OutputStream | null;
    stderr: OutputStream | null;
  };
}

export class BashExecFailure extends Error {
  readonly result?: BashExecResult;
  constructor(message: string, result?: BashExecResult) {
    super(result ? `${message}\nCommand diagnostics (capture may be incomplete): ${JSON.stringify(result)}` : message);
    this.name = "BashExecFailure";
    this.result = result;
  }
}

export function validateBashArguments(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("bash_exec requires an argument object");
  const value = input as Record<string, unknown>;
  const known = new Set(["command", "cwd", "timeout_seconds", "max_artifact_bytes", "max_preview_bytes"]);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`Unknown bash_exec argument: ${key}`);
  if (typeof value.command !== "string" || !value.command.trim() || value.command.includes("\0")
    || Buffer.byteLength(value.command) > BASH_LIMITS.maxCommandBytes) {
    throw new Error("command must be nonempty, NUL-free, and at most 131072 UTF-8 bytes");
  }
  const cwd = value.cwd === undefined ? "." : value.cwd;
  if (typeof cwd !== "string" || !cwd.trim() || Buffer.byteLength(cwd) > 4096 || cwd.includes("\0")) {
    throw new Error("cwd must be a nonempty NUL-free host path of at most 4096 UTF-8 bytes");
  }
  const integer = (key: string, fallback: number, maximum: number): number => {
    const v = value[key] ?? fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > maximum) {
      throw new Error(`${key} must be an integer between 1 and ${maximum}`);
    }
    return v;
  };
  const artifactBytes = integer("max_artifact_bytes", BASH_LIMITS.maxArtifactBytes, BASH_LIMITS.maxArtifactBytes);
  return {
    command: value.command, cwd,
    timeoutSeconds: integer("timeout_seconds", BASH_LIMITS.defaultCommandSeconds, BASH_LIMITS.maxCommandSeconds),
    artifactBytes,
    previewBytes: integer("max_preview_bytes", Math.min(BASH_LIMITS.defaultPreviewBytes, artifactBytes), artifactBytes),
  };
}

async function checkedCwd(root: string, requested: string): Promise<string> {
  // Keep the convenient session-relative default, but otherwise permit any
  // host path. realpath makes the spawn target stable and intentionally allows
  // symlinks; cwd is not a sandbox boundary.
  const directory = await fs.realpath(requested === "." ? root : resolve(root, requested));
  if (!(await fs.stat(directory)).isDirectory()) throw new Error(`cwd is not a directory: ${requested}`);
  return directory;
}

/** Normal inherited process environment, NOT an env_file/persistent-env feature. */
function shellEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const routing = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]);
  for (const key of Object.keys(env)) {
    if (routing.has(key) || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")
      || key === "BASH_ENV" || key === "ENV" || key.startsWith("BASH_FUNC_")) delete env[key];
  }
  return Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "false",
    SSH_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "never" });
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Captures a bounded raw prefix and drains ALL remaining output without buffering it. */
class Capture {
  total = 0;
  stored = 0;
  private previewLength = 0;
  private previews: Buffer[] = [];
  error?: string;
  readonly path: string;
  private file: FileHandle;
  private limit: number;
  private previewLimit: number;
  constructor(path: string, file: FileHandle, limit: number, previewLimit: number) {
    this.path = path; this.file = file; this.limit = limit; this.previewLimit = previewLimit;
  }
  async collect(reader: Readable, failed: () => void): Promise<void> {
    try {
      for await (const data of reader) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.total += chunk.length;
        const retained = chunk.subarray(0, Math.max(0, this.limit - this.stored));
        let offset = 0;
        while (offset < retained.length) {
          const { bytesWritten } = await this.file.write(retained, offset, retained.length - offset, null);
          if (!bytesWritten) throw new Error("zero-byte output artifact write");
          const preview = retained.subarray(offset, offset + Math.min(bytesWritten, this.previewLimit - this.previewLength));
          if (preview.length) { this.previews.push(Buffer.from(preview)); this.previewLength += preview.length; }
          offset += bytesWritten;
          this.stored += bytesWritten;
        }
      }
    } catch (error) { this.error = message(error); failed(); }
    finally {
      try { await this.file.close(); }
      catch (error) { this.error ??= message(error); failed(); }
    }
  }
  output(): OutputStream | null {
    if (!this.total) return null;
    const output: OutputStream = { preview: Buffer.concat(this.previews, this.previewLength).toString("utf8"),
      len: `${this.previewLength}/${this.total}` };
    if (this.total > this.previewLimit) output.path = this.path;
    return output;
  }
}

/** One command per POSIX process group, independent captures for concurrent calls. */
export class BashRunner {
  private active = new Map<AbortController, Promise<BashExecResult>>();
  private closing?: Promise<void>;
  readonly artifacts: CommandArtifacts;
  private shell: string;
  constructor(artifacts = new CommandArtifacts(), shell = "bash") {
    this.artifacts = artifacts; this.shell = shell;
  }

  run(root: string, input: BashExecArguments, signal?: AbortSignal): Promise<BashExecResult> {
    if (this.closing) return Promise.reject(new Error("bash_exec runner is closed"));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const command = this.runCommand(root, input, controller.signal);
    this.active.set(controller, command);
    return command.finally(() => {
      signal?.removeEventListener("abort", abort);
      this.active.delete(controller);
    });
  }

  /** Reload/teardown cancels owned commands before closing retention resources. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const controller of this.active.keys()) controller.abort(new Error("extension is shutting down"));
      await Promise.allSettled(this.active.values());
      await this.artifacts.close();
    })();
    return this.closing;
  }

  private async runCommand(root: string, input: BashExecArguments, signal?: AbortSignal): Promise<BashExecResult> {
    const args = validateBashArguments(input);
    signal?.throwIfAborted();
    if (process.platform === "win32") throw new Error("bash_exec requires a POSIX host (Linux/macOS)");
    const cwd = await checkedCwd(root, args.cwd);
    signal?.throwIfAborted();
    const lease = await this.artifacts.begin();
    if (signal?.aborted) {
      await Promise.all([lease.stdout.close(), lease.stderr.close()]);
      await lease.complete(); signal.throwIfAborted();
    }
    const started = performance.now();
    let child;
    try {
      child = spawn(this.shell, ["--noprofile", "--norc", "-c", args.command], {
        cwd, env: shellEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
    } catch (error) {
      await Promise.all([lease.stdout.close(), lease.stderr.close()]);
      await lease.complete(); throw new BashExecFailure(`Failed to start bash_exec: ${message(error)}`);
    }
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exited = false;
    let spawnError: string | undefined;
    let timedOut = false;
    let cancelled = false;
    let cleanupAttempted = false;
    let cleanupError: string | undefined;
    let terminating: Promise<void> | undefined;
    let wakeStop!: () => void;
    const stopped = new Promise<void>((resolve) => { wakeStop = resolve; });
    const exit = new Promise<void>((resolve) => {
      child.once("error", (error) => { spawnError = message(error); exited = true; resolve(); });
      child.once("exit", (code, sig) => { exitCode = code; exitSignal = sig; exited = true; resolve(); });
    });
    const send = (sig: NodeJS.Signals | 0): boolean => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, sig); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError ??= message(error);
        return false;
      }
    };
    const terminate = () => {
      if (terminating || !child.pid) return;
      cleanupAttempted = true;
      send("SIGTERM");
      terminating = delay(BASH_LIMITS.terminationGraceMs).then(() => { send("SIGKILL"); });
    };
    const stop = () => { terminate(); wakeStop(); };
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const stdout = new Capture(lease.stdoutPath, lease.stdout, args.artifactBytes, args.previewBytes);
    const stderr = new Capture(lease.stderrPath, lease.stderr, args.artifactBytes, args.previewBytes);
    const collected = Promise.all([stdout.collect(child.stdout!, stop), stderr.collect(child.stderr!, stop)]);
    const deadline = setTimeout(() => { timedOut = true; stop(); }, args.timeoutSeconds * 1000);
    try {
      await Promise.race([exit, stopped]);
      clearTimeout(deadline);
      // Even successful shells may leave background children holding pipe FDs.
      if (send(0)) terminate();
      await terminating;
      if (!exited && !await settles(exit, BASH_LIMITS.collectorSettleMs)) {
        cleanupError ??= "command did not exit after process-group termination";
      }
      if (!await settles(collected, BASH_LIMITS.collectorSettleMs)) {
        cleanupError ??= "output collectors did not settle; an escaped descendant may still own a pipe";
        child.stdout!.destroy(new Error("capture cleanup deadline exceeded"));
        child.stderr!.destroy(new Error("capture cleanup deadline exceeded"));
        await settles(collected, BASH_LIMITS.collectorSettleMs);
      }
      await lease.complete().catch((error) => { cleanupError ??= `artifact retention marker: ${message(error)}`; });
      const result: BashExecResult = { cwd: args.cwd, outcome: {
        command_id: lease.commandId, exit_code: exitCode,
        signal: exitSignal ? osConstants.signals[exitSignal] ?? null : null,
        timed_out: timedOut, descendant_cleanup_attempted: cleanupAttempted,
        duration_ms: Math.round(performance.now() - started), stdout: stdout.output(), stderr: stderr.output(),
      } };
      if (spawnError) throw new BashExecFailure(`Failed to start bash_exec: ${spawnError}`, result);
      if (cancelled) throw new BashExecFailure("bash_exec cancelled; filesystem effects are not rolled back", result);
      if (cleanupError || stdout.error || stderr.error) {
        throw new BashExecFailure(`bash_exec capture/cleanup failed: ${cleanupError ?? stdout.error ?? stderr.error}`, result);
      }
      // Like workspace-mcp, a completed tool result is not a successful shell exit.
      return result;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      if (!exited) { send("SIGKILL"); child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); }
    }
  }
}
