// Parser and exact line-matching semantics adapted from workspace-mcp (MIT).
// See NOTICE for the reference revision and attribution.
import { isAbsolute, win32 } from "node:path";

export const LIMITS = Object.freeze({
  maxPatchBytes: 33_554_432,
  maxOperations: 128,
  maxFileBytes: 4_194_304,
  maxPlannedBytes: 33_554_432,
});

export interface Hunk {
  locator?: string;
  old: string[];
  replacement: string[];
  added: number;
  removed: number;
  eof: boolean;
}

export type Operation =
  | { action: "add"; path: string; content: Buffer }
  | { action: "delete"; path: string }
  | { action: "update"; path: string; moveTo?: string; hunks: Hunk[] };

/** Require portable, already-normalized workspace-relative paths. */
export function validatePath(path: string): void {
  if (!path || Buffer.byteLength(path) > 4096 || /[\0\\]/u.test(path)
      || isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/iu.test(path)) {
    throw new Error(`Invalid workspace-relative patch path: ${JSON.stringify(path)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Patch path must already be normalized: ${JSON.stringify(path)}`);
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new Error(`Git metadata is not a patch target: ${JSON.stringify(path)}`);
  }
}

const isHeader = (line: string): boolean =>
  ["*** Add File: ", "*** Delete File: ", "*** Update File: "]
    .some((prefix) => line.startsWith(prefix)) || line === "*** End Patch";

export function parsePatch(patch: string): Operation[] {
  if (typeof patch !== "string" || !patch || Buffer.byteLength(patch) > LIMITS.maxPatchBytes) {
    throw new Error(`patch must be a nonempty string of at most ${LIMITS.maxPatchBytes} UTF-8 bytes`);
  }
  // Permit exactly one final newline, not wrappers or arbitrary whitespace.
  const lines = patch.replace(/\r?\n$/u, "").split("\n")
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Patch must start with '*** Begin Patch' and end with '*** End Patch'");
  }
  const operations: Operation[] = [];
  const end = lines.length - 1;
  let i = 1;
  while (i < end) {
    if (operations.length >= LIMITS.maxOperations) {
      throw new Error(`Patch exceeds ${LIMITS.maxOperations} file operations`);
    }
    const header = lines[i++];
    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      validatePath(path);
      const content: string[] = [];
      while (i < end && !isHeader(lines[i])) {
        if (!lines[i].startsWith("+")) throw new Error(`Add-file line ${i + 1} must start with '+'`);
        content.push(lines[i++].slice(1) + "\n");
      }
      operations.push({ action: "add", path, content: Buffer.from(content.join("")) });
    } else if (header.startsWith("*** Delete File: ")) {
      const path = header.slice("*** Delete File: ".length);
      validatePath(path);
      operations.push({ action: "delete", path });
    } else if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length);
      validatePath(path);
      let moveTo: string | undefined;
      if (i < end && lines[i].startsWith("*** Move to: ")) {
        moveTo = lines[i++].slice("*** Move to: ".length);
        validatePath(moveTo);
      }
      const hunks: Hunk[] = [];
      let current: Hunk | undefined;
      let afterEof = false;
      const finish = (): void => {
        if (!current) return;
        if (!current.old.length && !current.replacement.length) {
          throw new Error(`Empty hunk for ${path} near line ${i + 1}`);
        }
        hunks.push(current);
      };
      while (i < end && !isHeader(lines[i])) {
        const line = lines[i++];
        const marker = line === "@@" || line.startsWith("@@ ");
        if (afterEof && !marker) throw new Error(`Expected '@@' after '*** End of File' in ${path}`);
        if (marker) {
          finish();
          current = {
            locator: line.startsWith("@@ ") ? line.slice(3) || undefined : undefined,
            old: [], replacement: [], added: 0, removed: 0, eof: false,
          };
          afterEof = false;
        } else if (line === "*** End of File") {
          if (!current || (!current.old.length && !current.replacement.length)) {
            throw new Error(`End-of-file marker without a nonempty hunk in ${path}`);
          }
          current.eof = true;
          afterEof = true;
        } else {
          if (!current) throw new Error(`Each update hunk in ${path} must begin with '@@' or '@@ <locator>'`);
          const text = line.slice(1);
          switch (line[0]) {
            case " ": current.old.push(text); current.replacement.push(text); break;
            case "-": current.old.push(text); current.removed++; break;
            case "+": current.replacement.push(text); current.added++; break;
            default: throw new Error(`Update-file line ${i} must start with ' ', '+' or '-'`);
          }
        }
      }
      finish();
      if (!hunks.length && !moveTo) throw new Error(`Update for ${path} has no hunks`);
      operations.push({ action: "update", path, moveTo, hunks });
    } else {
      throw new Error(`Unknown patch header at line ${i}: ${header}`);
    }
  }
  if (!operations.length) throw new Error("Patch contains no file operations");
  return operations;
}

function seek(lines: string[], pattern: string[], start: number, eof = false): number {
  const last = lines.length - pattern.length;
  if (last < start) return -1;
  for (let i = eof ? last : start; i <= last; i++) {
    if (pattern.every((line, j) => line === lines[i + j])) return i;
  }
  return -1;
}

export function applyHunks(path: string, original: string, hunks: Hunk[]): {
  content: Buffer; added: number; removed: number;
} {
  const crlf = original.includes("\r\n");
  if (crlf && /(?<!\r)\n/u.test(original)) {
    throw new Error(`Mixed LF/CRLF line endings in ${path}; normalize intentionally before patching`);
  }
  const newline = crlf ? "\r\n" : "\n";
  const normalized = crlf ? original.replaceAll("\r\n", "\n") : original;
  const trailing = normalized.endsWith("\n");
  let lines = normalized ? normalized.split("\n") : [];
  if (trailing) lines.pop();
  let cursor = 0;
  let added = 0;
  let removed = 0;
  for (const [index, hunk] of hunks.entries()) {
    let start = cursor;
    if (hunk.locator !== undefined) {
      const at = seek(lines, [hunk.locator], cursor);
      if (at < 0) throw new Error(`Exact locator not found in ${path} (hunk ${index + 1}); re-read using bash and order hunks top to bottom`);
      start = at + 1;
    }
    if (!hunk.old.length) {
      // Codex pure insertions append, even when a locator is supplied.
      lines = lines.concat(hunk.replacement);
    } else {
      const at = seek(lines, hunk.old, start, hunk.eof);
      if (at < 0) throw new Error(`Exact context not found in ${path} (hunk ${index + 1}, search from logical line ${start + 1}); re-read using bash and order hunks top to bottom`);
      // Avoid spread/splice argument-count limits on large hunks.
      lines = lines.slice(0, at).concat(hunk.replacement, lines.slice(at + hunk.old.length));
      cursor = at + hunk.replacement.length;
    }
    added += hunk.added;
    removed += hunk.removed;
  }
  let result = lines.join(newline);
  if (trailing && lines.length) result += newline;
  return { content: Buffer.from(result), added, removed };
}
