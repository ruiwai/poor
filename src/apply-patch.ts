import { realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { applyHunks, LIMITS, parsePatch, type Operation } from "./patch.ts";
import { errorMessage, LocalWorkspace, snapshot, type Mutation, type Snapshot } from "./workspace.ts";

export interface PatchedFile {
  path: string;
  previous_path: string | null;
  action: "added" | "updated" | "deleted" | "moved";
  before_sha256: string | null;
  after_sha256: string | null;
  lines_added: number;
  lines_removed: number;
}

export interface PatchResult { files: PatchedFile[] }
export interface PatchDiagnostics {
  patch_effect: "unchanged" | "rolled_back" | "partial";
  committed_operations: number;
  failed_operation: number | null;
  failed_path: string | null;
  recovery_errors: string[];
}

export class PatchFailure extends Error {
  readonly diagnostics: PatchDiagnostics;
  constructor(message: string, diagnostics: PatchDiagnostics) {
    super(message);
    this.name = "PatchFailure";
    this.diagnostics = diagnostics;
  }
}

interface PlanEntry {
  operation: Operation;
  before: Snapshot | null;
  after: Snapshot | null;
  result: PatchedFile;
}

function countLines(content: Buffer): number {
  if (!content.length) return 0;
  let count = content.at(-1) === 10 ? 0 : 1;
  for (const byte of content) if (byte === 10) count++;
  return count;
}

async function buildPlan(workspace: LocalWorkspace, operations: Operation[], signal?: AbortSignal): Promise<PlanEntry[]> {
  const paths = new Set<string>();
  let retainedBytes = 0;
  const reserve = (path: string): void => {
    for (const existing of paths) {
      if (path === existing || path.startsWith(existing + "/") || existing.startsWith(path + "/")) {
        throw new Error(`Duplicate or ancestor/descendant patch paths: ${existing} and ${path}`);
      }
    }
    paths.add(path);
  };
  const retain = (bytes: number): void => {
    retainedBytes += bytes;
    if (retainedBytes > LIMITS.maxPlannedBytes) throw new Error(`Patch exceeds ${LIMITS.maxPlannedBytes} retained planning bytes`);
  };
  const plan: PlanEntry[] = [];
  for (const operation of operations) {
    signal?.throwIfAborted();
    reserve(operation.path);
    const moveTo = operation.action === "update" ? operation.moveTo : undefined;
    if (moveTo) {
      reserve(moveTo);
      if (await workspace.read(moveTo)) throw new Error(`Move destination already exists: ${moveTo}`);
    }
    const before = await workspace.read(operation.path);
    let after: Snapshot | null;
    let added = 0;
    let removed = 0;
    if (operation.action === "add") {
      if (before) throw new Error(`Cannot add existing file: ${operation.path}`);
      after = snapshot(operation.content, 0o666 & ~process.umask());
      added = countLines(operation.content);
      retain(operation.content.length);
    } else {
      if (!before) throw new Error(`File does not exist: ${operation.path}`);
      retain(before.content.length);
      if (operation.action === "delete") {
        after = null;
        removed = countLines(before.content);
      } else if (moveTo && !operation.hunks.length) {
        after = before; // Binary-safe move; retain only one copy.
      } else {
        let original: string;
        try {
          // ignoreBOM means retain a BOM as content, rather than stripping it.
          original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before.content);
        } catch { throw new Error(`${operation.path} must contain UTF-8 text for an update`); }
        const updated = applyHunks(operation.path, original, operation.hunks);
        after = snapshot(updated.content, before.mode);
        added = updated.added;
        removed = updated.removed;
        retain(updated.content.length);
      }
    }
    if (after && after.content.length > LIMITS.maxFileBytes) {
      throw new Error(`Patched file exceeds ${LIMITS.maxFileBytes} bytes: ${operation.path}`);
    }
    plan.push({ operation, before, after, result: {
      path: moveTo ?? operation.path,
      previous_path: moveTo ? operation.path : null,
      action: operation.action === "add" ? "added" : operation.action === "delete" ? "deleted" : moveTo ? "moved" : "updated",
      before_sha256: before?.sha256 ?? null,
      after_sha256: after?.sha256 ?? null,
      lines_added: added,
      lines_removed: removed,
    } });
  }
  return plan;
}

/** Exported separately so filesystem failures can be deterministically tested. */
export async function applyPatchInWorkspace(workspace: LocalWorkspace, patch: string, signal?: AbortSignal): Promise<PatchResult> {
  const journal: Mutation[] = [];
  const record = (mutation: Mutation): void => { journal.push(mutation); };
  let committed = 0;
  let failedOperation: number | null = null;
  let failedPath: string | null = null;
  try {
    signal?.throwIfAborted();
    const plan = await buildPlan(workspace, parsePatch(patch), signal);
    // Verify every target again before publishing the first change.
    for (const { operation, before } of plan) {
      signal?.throwIfAborted();
      await workspace.expect(operation.path, before);
      if (operation.action === "update" && operation.moveTo) await workspace.expect(operation.moveTo, null);
    }
    for (const [index, entry] of plan.entries()) {
      const { operation, before, after } = entry;
      failedOperation = index + 1;
      failedPath = operation.path;
      signal?.throwIfAborted();
      if (operation.action === "delete") {
        await workspace.remove(operation.path, before!, record, signal);
      } else if (operation.action === "update" && operation.moveTo) {
        await workspace.write(operation.moveTo, null, after!, record, signal);
        await workspace.remove(operation.path, before!, record, signal);
      } else {
        await workspace.write(operation.path, before, after!, record, signal);
      }
      committed++;
    }
    signal?.throwIfAborted();
    return { files: plan.map((entry) => entry.result) };
  } catch (error) {
    const recoveryErrors: string[] = [];
    // Compensation ignores cancellation, but never knowingly overwrites a
    // third-party change. This is NOT an atomic multi-file transaction.
    for (const mutation of [...journal].reverse()) {
      try {
        if (mutation.before === null) {
          await workspace.remove(mutation.path, mutation.after!, () => {});
        } else {
          await workspace.write(mutation.path, mutation.after, mutation.before, () => {});
        }
      } catch (recoveryError) {
        recoveryErrors.push(`${mutation.path}: ${errorMessage(recoveryError)}`);
      }
    }
    recoveryErrors.push(...await workspace.cleanup());
    const effect = recoveryErrors.length ? "partial"
      : journal.length || workspace.createdDirectories.length ? "rolled_back" : "unchanged";
    throw new PatchFailure(errorMessage(error), {
      patch_effect: effect, committed_operations: committed,
      failed_operation: failedOperation, failed_path: failedPath, recovery_errors: recoveryErrors,
    });
  }
}

const queues = new Map<string, Promise<void>>();

/** Serialize this extension's patches for each canonical cwd. */
export async function applyPatch(cwd: string, patch: string, signal?: AbortSignal): Promise<PatchResult> {
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  const previous = queues.get(root) ?? Promise.resolve();
  const task = previous.then(() => applyPatchInWorkspace(new LocalWorkspace(root), patch, signal));
  const tail = task.then(() => {}, () => {});
  queues.set(root, tail);
  try { return await task; }
  finally { if (queues.get(root) === tail) queues.delete(root); }
}
