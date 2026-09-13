import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyPatch, applyPatchInWorkspace, PatchFailure } from "../src/apply-patch.ts";
import { LIMITS, parsePatch, validatePath } from "../src/patch.ts";
import { LocalWorkspace } from "../src/workspace.ts";

const patch = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;
const update = (body: string, path = "note"): string => patch(`*** Update File: ${path}\n${body}`);
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

async function fixture(t: TestContext, files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-patch-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) await fs.writeFile(join(root, path), content);
  return root;
}

async function absent(path: string): Promise<void> {
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}

test("add, update, move and delete in one preflighted patch", async (t) => {
  const root = await fixture(t, { note: "first\nold\nlast\n", bye: "bye\n" });
  const result = await applyPatch(root, patch("*** Add File: sub/new\n+hello\n*** Update File: note\n*** Move to: moved\n@@\n first\n-old\n+new\n last\n*** Delete File: bye"));
  assert.equal(await fs.readFile(join(root, "sub/new"), "utf8"), "hello\n");
  assert.equal(await fs.readFile(join(root, "moved"), "utf8"), "first\nnew\nlast\n");
  await absent(join(root, "note"));
  await absent(join(root, "bye"));
  assert.deepEqual(result.files.map((file) => file.action), ["added", "moved", "deleted"]);
  assert.deepEqual(result.files[1], {
    path: "moved", previous_path: "note", action: "moved",
    before_sha256: hash("first\nold\nlast\n"), after_sha256: hash("first\nnew\nlast\n"),
    lines_added: 1, lines_removed: 1,
  });
  assert.deepEqual((await fs.readdir(root)).sort(), ["moved", "sub"]);
});

test("preflight failure leaves all files and parent directories unchanged", async (t) => {
  const root = await fixture(t, { note: "old\n" });
  await assert.rejects(applyPatch(root, patch("*** Add File: new/child\n+x\n*** Update File: note\n@@\n-missing\n+new")), (error) => {
    assert.ok(error instanceof PatchFailure);
    assert.equal(error.diagnostics.patch_effect, "unchanged");
    return true;
  });
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "old\n");
  await absent(join(root, "new"));
});

for (const [original, replacement, expected] of [
  ["hello\n", "@@\n-hello\n+", "\n"],
  ["hello\n\n", "@@\n-hello\n-\n+", "\n"],
  ["hello", "@@\n-hello\n+changed", "changed"],
  ["hello\n", "@@\n-hello", ""],
  ["\n\n", "@@\n-\n-", ""],
  ["", "@@\n+new", "new"],
  ["a\r\nb\r\n", "@@\n-a\n+A", "A\r\nb\r\n"],
  ["a\r\nb", "@@\n-b\n+B", "a\r\nB"],
  ["\ufeffhello\n", "@@\n-\ufeffhello\n+\ufeffworld", "\ufeffworld\n"],
] as const) {
  test(`preserve logical lines/newlines: ${JSON.stringify(original)} -> ${JSON.stringify(expected)}`, async (t) => {
    const root = await fixture(t, { note: original });
    await applyPatch(root, update(replacement));
    assert.equal(await fs.readFile(join(root, "note"), "utf8"), expected);
  });
}

for (const [actual, incorrect] of [
  ["  old", "old"], ["old  ", "old"], ["old\t", "old "],
  ["smart—dash", "smart-dash"], ["caf\u00e9", "cafe\u0301"],
] as const) {
  test(`context and locators are exact: ${JSON.stringify(actual)}`, async (t) => {
    const root = await fixture(t, { note: `${actual}\nbody\n` });
    await assert.rejects(applyPatch(root, update(`@@\n-${incorrect}\n+changed`)), /Exact context/);
    await assert.rejects(applyPatch(root, update(`@@ ${incorrect}\n-body\n+changed`)), /Exact locator/);
    assert.equal(await fs.readFile(join(root, "note"), "utf8"), `${actual}\nbody\n`);
  });
}

test("locators, ordered hunks, append and EOF anchoring", async (t) => {
  const root = await fixture(t, { note: "first\nold\nsecond\nold\n" });
  await applyPatch(root, update("@@ second\n-old\n+new\n*** End of File\n@@ first\n+appended"))
    .then(() => assert.fail("backward locator must fail"), () => {});
  await applyPatch(root, update("@@ second\n-old\n+new\n*** End of File\n@@\n+appended"));
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "first\nold\nsecond\nnew\nappended\n");
});

test("pure insertion after locator still appends, and EOF chooses last occurrence", async (t) => {
  const root = await fixture(t, { note: "head\nx\nx\n" });
  await applyPatch(root, update("@@ head\n+tail"));
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "head\nx\nx\ntail\n");
  await applyPatch(root, update("@@\n-x\n-tail\n+end\n*** End of File"));
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "head\nx\nend\n");
});

test("mixed line endings reject updates but allow byte-preserving moves", async (t) => {
  const content = "a\r\nb\n";
  const root = await fixture(t, { note: content });
  await assert.rejects(applyPatch(root, update("@@\n-a\n+A")), /Mixed LF\/CRLF/);
  await applyPatch(root, patch("*** Update File: note\n*** Move to: moved"));
  assert.equal(await fs.readFile(join(root, "moved"), "utf8"), content);
});

test("binary move/delete and executable permissions", async (t) => {
  const binary = Buffer.from([0, 255, 1, 128, 10]);
  const root = await fixture(t, { note: binary, script: "old\n" });
  await fs.chmod(join(root, "script"), 0o751);
  await assert.rejects(applyPatch(root, update("@@\n+x")), /UTF-8/);
  const result = await applyPatch(root, patch("*** Update File: note\n*** Move to: moved\n*** Update File: script\n@@\n-old\n+new"));
  assert.deepEqual(await fs.readFile(join(root, "moved")), binary);
  assert.equal(result.files[0].before_sha256, result.files[0].after_sha256);
  assert.equal((await fs.stat(join(root, "script"))).mode & 0o777, 0o751);
  await applyPatch(root, patch("*** Delete File: moved"));
  await absent(join(root, "moved"));
});

test("empty add, literal special-character paths and CRLF patch transport", async (t) => {
  const root = await fixture(t);
  await applyPatch(root, patch("*** Add File: empty\n*** Add File: space ' $(literal).txt\n+hello").replaceAll("\n", "\r\n") + "\r\n");
  assert.equal((await fs.stat(join(root, "empty"))).size, 0);
  assert.equal(await fs.readFile(join(root, "space ' $(literal).txt"), "utf8"), "hello\n");
});

for (const invalid of [
  "", "*** Begin Patch\n*** End Patch", "\n" + patch("*** Add File: a\n+x"),
  patch("*** Add File: a\n+x") + "\n\n", "<<'EOF'\n" + patch("*** Add File: a\n+x") + "\nEOF",
  patch("*** Add File: a\nx"), patch("*** Update File: a\n-x\n+y"),
  patch("*** Update File: a\n@@"), patch("*** Update File: a\n@@\n-x\n\n+y"),
  patch("*** Update File: a\n*** End of File"),
  patch("*** Update File: a\n@@\n+x\n*** End of File\n+y"),
  patch("*** Environment ID: old\n*** Add File: a\n+x"),
  "*** Begin Patch \n*** Add File: a\n+x\n*** End Patch",
]) {
  test(`reject malformed patch: ${JSON.stringify(invalid).slice(0, 90)}`, () => {
    assert.throws(() => parsePatch(invalid));
  });
}

for (const invalid of ["", "../x", "/tmp/x", "./x", "a/../b", "a//b", "a/", ".git/config", "a/.GIT/config", "a\0b", "a\\b", "C:/file"]) {
  test(`reject unsafe/non-normalized path: ${JSON.stringify(invalid)}`, () => assert.throws(() => validatePath(invalid)));
}

test("reject duplicate, ancestor and move-target collisions before changes", async (t) => {
  const root = await fixture(t, { note: "old\n", other: "other\n" });
  for (const body of [
    "*** Add File: a\n+x\n*** Add File: a\n+y",
    "*** Add File: a\n+x\n*** Add File: a/b\n+y",
    "*** Add File: a/b\n+x\n*** Add File: a\n+y",
    "*** Update File: note\n*** Move to: note",
    "*** Update File: note\n*** Move to: other",
    "*** Add File: note\n+x",
    "*** Delete File: missing",
  ]) await assert.rejects(applyPatch(root, patch(body)));
  assert.deepEqual((await fs.readdir(root)).sort(), ["note", "other"]);
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "old\n");
});

test("reject leaf, dangling and parent symlinks and directories", async (t) => {
  const outside = await fixture(t, { file: "outside\n" });
  const root = await fixture(t, { note: "old\n" });
  await fs.symlink(join(outside, "file"), join(root, "link"));
  await fs.symlink(join(outside, "absent"), join(root, "dangling"));
  await fs.symlink(outside, join(root, "parent"));
  await fs.mkdir(join(root, "directory"));
  for (const body of [
    "*** Delete File: link", "*** Add File: dangling\n+x", "*** Add File: parent/new\n+x",
    "*** Update File: note\n*** Move to: parent/moved", "*** Delete File: directory",
  ]) await assert.rejects(applyPatch(root, patch(body)), /non-symlink|real directory/);
  assert.equal(await fs.readFile(join(outside, "file"), "utf8"), "outside\n");
  await absent(join(outside, "new"));
});

test("operation, UTF-8 input-byte and per-file limits", async (t) => {
  assert.throws(() => parsePatch(patch(Array.from({ length: 129 }, (_, i) => `*** Add File: f${i}`).join("\n"))), /128/);
  assert.throws(() => parsePatch("🙂".repeat(LIMITS.maxPatchBytes / 4 + 1)), /UTF-8 bytes/);
  const root = await fixture(t, { note: Buffer.alloc(LIMITS.maxFileBytes + 1, 120) });
  await assert.rejects(applyPatch(root, patch("*** Delete File: note")), /exceeds/);
  await assert.rejects(applyPatch(root, patch("*** Add File: new\n+" + "x".repeat(LIMITS.maxFileBytes))), /exceeds/);
  await absent(join(root, "new"));
});

test("aggregate planning bytes are bounded before mutations", async (t) => {
  const root = await fixture(t);
  const content = "x".repeat(LIMITS.maxFileBytes - 2);
  for (let i = 0; i < 5; i++) await fs.writeFile(join(root, `f${i}`), content);
  await assert.rejects(applyPatch(root, patch(Array.from({ length: 5 }, (_, i) => `*** Update File: f${i}\n@@\n+x`).join("\n"))), /retained planning bytes/);
  assert.equal((await fs.stat(join(root, "f0"))).size, content.length);
});

test("late I/O failure compensates earlier mutations and removes new directories", async (t) => {
  const root = await fixture(t, { fail: "old\n" });
  class FailingWorkspace extends LocalWorkspace {
    override async write(...args: Parameters<LocalWorkspace["write"]>): Promise<void> {
      if (args[0] === "fail") throw new Error("injected write failure");
      await super.write(...args);
    }
  }
  await assert.rejects(applyPatchInWorkspace(new FailingWorkspace(root), patch("*** Add File: sub/added\n+x\n*** Update File: fail\n@@\n-old\n+new")), (error) => {
    assert.ok(error instanceof PatchFailure);
    assert.equal(error.diagnostics.patch_effect, "rolled_back");
    assert.equal(error.diagnostics.committed_operations, 1);
    assert.equal(error.diagnostics.failed_operation, 2);
    assert.deepEqual(error.diagnostics.recovery_errors, []);
    return true;
  });
  assert.equal(await fs.readFile(join(root, "fail"), "utf8"), "old\n");
  await absent(join(root, "sub"));
});

test("failed move source deletion compensates the published destination", async (t) => {
  const root = await fixture(t, { note: "old\n" });
  class FailingMove extends LocalWorkspace {
    override async remove(...args: Parameters<LocalWorkspace["remove"]>): Promise<void> {
      if (args[0] === "note") throw new Error("injected unlink failure");
      await super.remove(...args);
    }
  }
  await assert.rejects(applyPatchInWorkspace(new FailingMove(root), patch("*** Update File: note\n*** Move to: moved")), (error) => {
    assert.ok(error instanceof PatchFailure);
    assert.equal(error.diagnostics.patch_effect, "rolled_back");
    return true;
  });
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "old\n");
  await absent(join(root, "moved"));
});

test("rollback refuses to overwrite concurrent external changes and reports partial effects", async (t) => {
  const root = await fixture(t, { note: "old\n" });
  class ConcurrentWorkspace extends LocalWorkspace {
    override async write(...args: Parameters<LocalWorkspace["write"]>): Promise<void> {
      if (args[0] === "fail") {
        await fs.writeFile(join(root, "note"), "external\n");
        throw new Error("injected failure after external edit");
      }
      await super.write(...args);
    }
  }
  await assert.rejects(applyPatchInWorkspace(new ConcurrentWorkspace(root), patch("*** Update File: note\n@@\n-old\n+new\n*** Add File: fail\n+x")), (error) => {
    assert.ok(error instanceof PatchFailure);
    assert.equal(error.diagnostics.patch_effect, "partial");
    assert.equal(error.diagnostics.recovery_errors.length, 1);
    return true;
  });
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "external\n");
});

test("abort before starting and abort after publication both avoid unnoticed changes", async (t) => {
  const root = await fixture(t, { note: "old\n" });
  await assert.rejects(applyPatch(root, update("@@\n-old\n+new"), AbortSignal.abort()));
  const controller = new AbortController();
  class AbortingWorkspace extends LocalWorkspace {
    override async write(...args: Parameters<LocalWorkspace["write"]>): Promise<void> {
      await super.write(...args);
      controller.abort();
    }
  }
  await assert.rejects(applyPatchInWorkspace(new AbortingWorkspace(root), update("@@\n-old\n+new"), controller.signal), (error) => {
    assert.ok(error instanceof PatchFailure);
    assert.equal(error.diagnostics.patch_effect, "rolled_back");
    return true;
  });
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "old\n");
});

test("parallel calls serialize per cwd and a rejected call does not poison the queue", async (t) => {
  const root = await fixture(t, { note: "old\n" });
  const results = await Promise.allSettled([
    applyPatch(root, update("@@\n-missing\n+bad")),
    applyPatch(root, update("@@\n-old\n+new")),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "fulfilled"]);
  await Promise.all([
    applyPatch(root, patch("*** Add File: one\n+1")),
    applyPatch(root, patch("*** Add File: two\n+2")),
  ]);
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "new\n");
  assert.deepEqual((await fs.readdir(root)).sort(), ["note", "one", "two"]);
});
