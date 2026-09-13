import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { LIMITS, validatePath } from "./patch.ts";

export interface Snapshot {
  content: Buffer;
  mode: number;
  sha256: string;
}

export interface Mutation {
  path: string;
  before: Snapshot | null;
  after: Snapshot | null;
}

export type RecordMutation = (mutation: Mutation) => void;

export function snapshot(content: Buffer, mode: number): Snapshot {
  return { content, mode, sha256: createHash("sha256").update(content).digest("hex") };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Local filesystem adapter. Paths are checked again immediately before changes.
 * This is NOT a capability sandbox: hostile concurrent directory replacement
 * cannot be fully excluded using portable Node path-based filesystem APIs.
 */
export class LocalWorkspace {
  readonly root: string;
  readonly createdDirectories: string[] = [];
  private readonly temporaryFiles = new Set<string>();

  constructor(root: string) { this.root = root; }

  private async parents(path: string, create = false): Promise<boolean> {
    validatePath(path);
    const parts = path.split("/").slice(0, -1);
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        if (!create) return false;
        try {
          await fs.mkdir(current);
          this.createdDirectories.push(current);
        } catch (mkdirError) {
          if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
        }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Patch parent is not a real directory: ${current}`);
      }
    }
    return true;
  }

  async read(path: string): Promise<Snapshot | null> {
    if (!await this.parents(path)) return null;
    const absolute = join(this.root, path);
    let stat;
    try { stat = await fs.lstat(absolute); }
    catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Patch target is not a regular, non-symlink file: ${path}`);
    }
    const handle = await fs.open(absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error(`Patch target is not a regular file: ${path}`);
      if (opened.size > LIMITS.maxFileBytes) throw new Error(`File exceeds ${LIMITS.maxFileBytes} bytes: ${path}`);
      // Bound actual reads too, even if another process grows the file.
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(65_536, LIMITS.maxFileBytes + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > LIMITS.maxFileBytes) throw new Error(`File exceeds ${LIMITS.maxFileBytes} bytes: ${path}`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return snapshot(Buffer.concat(chunks, total), opened.mode & 0o777);
    } finally { await handle.close(); }
  }

  async expect(path: string, expected: Snapshot | null): Promise<void> {
    const current = await this.read(path);
    if (current?.sha256 !== expected?.sha256 || current?.mode !== expected?.mode) {
      throw new Error(`File changed since preflight (or already exists): ${path}; re-read before retrying`);
    }
  }

  async write(
    path: string, expected: Snapshot | null, next: Snapshot,
    record: RecordMutation, signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.parents(path, true);
    const target = join(this.root, path);
    const temporary = join(dirname(target), `.pi-apply-patch-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    this.temporaryFiles.add(temporary);
    try {
      try {
        await handle.writeFile(next.content);
        await handle.chmod(next.mode);
        await handle.sync();
      } finally { await handle.close(); }
      await this.expect(path, expected);
      signal?.throwIfAborted();
      if (expected === null) {
        // link(), unlike rename(), will not overwrite an existing destination.
        await fs.link(temporary, target);
      } else {
        await fs.rename(temporary, target);
      }
      // Record before any further await: publication has happened, even if
      // temporary-file cleanup or a later operation subsequently fails.
      record({ path, before: expected, after: next });
    } finally {
      try { await fs.unlink(temporary); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      this.temporaryFiles.delete(temporary);
    }
  }

  async remove(
    path: string, expected: Snapshot, record: RecordMutation, signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.expect(path, expected);
    signal?.throwIfAborted();
    await fs.unlink(join(this.root, path));
    record({ path, before: expected, after: null });
  }

  /** Only used on failure. Never recursively removes directories. */
  async cleanup(): Promise<string[]> {
    const errors: string[] = [];
    for (const file of this.temporaryFiles) {
      try { await fs.unlink(file); }
      catch (error) { if (!hasCode(error, "ENOENT")) errors.push(`${file}: ${errorMessage(error)}`); }
    }
    for (const directory of [...this.createdDirectories].reverse()) {
      try { await fs.rmdir(directory); }
      catch (error) { if (!hasCode(error, "ENOENT")) errors.push(`${directory}: ${errorMessage(error)}`); }
    }
    return errors;
  }
}
