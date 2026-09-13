import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BashRunner, BashExecFailure, bashParameters, validateBashArguments, type BashExecArguments } from "../src/bash-exec.ts";
import { CommandArtifacts, ARTIFACT_RETENTION_SECONDS } from "../src/command-artifacts.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-shell-test-"));
  const base = join(root, "captures");
  await fs.mkdir(base);
  const store = new CommandArtifacts(base);
  const runner = new BashRunner(store);
  t.after(async () => { await runner.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, base, store, runner };
}
async function waitFile(path: string) {
  for (let i = 0; i < 200; i++) {
    if (await fs.stat(path).then(() => true, () => false)) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for test child: ${path}`);
}

test("bash_exec schema matches reference fields and wire bounds except session/env_file", () => {
  const schema = JSON.parse(JSON.stringify(bashParameters));
  assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "cwd", "max_artifact_bytes", "max_preview_bytes", "timeout_seconds"]);
  assert.deepEqual(schema.required, ["command"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.command.maxLength, 131072);
  assert.equal(schema.properties.timeout_seconds.anyOf[0].maximum, 3600);
  assert.equal(schema.properties.max_artifact_bytes.anyOf[0].maximum, 67108864);
  assert.deepEqual(validateBashArguments({ command: "true", timeout_seconds: null, max_preview_bytes: null }), {
    command: "true", cwd: ".", timeoutSeconds: 120, artifactBytes: 262144, previewBytes: 1024,
  });
});

test("capture matches the directly exercised workspace-mcp truncation and exit-7 probe", async (t) => {
  const { root, runner } = await fixture(t);
  // Observed using the live workspace-mcp tool, not inferred from its source.
  const result = await runner.run(root, {
    command: "printf 'abcdefghijklmnopqrstuvwxyz0123456789'; printf 'stderr-example-abcdefghijklmnopqrstuvwxyz' >&2; exit 7",
    max_artifact_bytes: 24, max_preview_bytes: 8, timeout_seconds: 5,
  });
  assert.equal(result.cwd, ".");
  assert.equal(result.outcome.exit_code, 7);
  assert.equal(result.outcome.signal, null);
  assert.equal(result.outcome.timed_out, false);
  assert.equal(result.outcome.descendant_cleanup_attempted, false);
  const { path: outPath, ...out } = result.outcome.stdout;
  const { path: errPath, ...err } = result.outcome.stderr;
  assert.deepEqual(out, { preview: "abcdefgh", preview_bytes: 8, total_bytes: 36, stored_bytes: 24,
    preview_truncated: true, storage_truncated: true });
  assert.deepEqual(err, { preview: "stderr-e", preview_bytes: 8, total_bytes: 41, stored_bytes: 24,
    preview_truncated: true, storage_truncated: true });
  assert.equal(await fs.readFile(outPath, "utf8"), "abcdefghijklmnopqrstuvwx");
  assert.equal(await fs.readFile(errPath, "utf8"), "stderr-example-abcdefghijklmnopqrstuvwxyz".slice(0, 24));
  assert.equal((await fs.stat(outPath)).mode & 0o777, 0o600);
  assert.notEqual(outPath, errPath);
  assert.match(outPath, new RegExp(result.outcome.command_id));
});

test("preview truncation and storage truncation are separate", async (t) => {
  const { root, runner } = await fixture(t);
  const { outcome } = await runner.run(root, { command: "printf 0123456789", max_preview_bytes: 4, max_artifact_bytes: 16 });
  assert.equal(outcome.stdout.preview, "0123");
  assert.equal(outcome.stdout.preview_truncated, true);
  assert.equal(outcome.stdout.storage_truncated, false);
  assert.equal(await fs.readFile(outcome.stdout.path, "utf8"), "0123456789");
  assert.equal(outcome.stderr.preview_bytes, 0);
  assert.equal(outcome.stderr.storage_truncated, false);
  const reread = await runner.run(root, { command: `cat -- ${quote(outcome.stdout.path)}` });
  assert.equal(reread.outcome.stdout.preview, "0123456789");
});

test("raw UTF-8 and invalid-byte previews preserve raw byte accounting", async (t) => {
  const { root, runner } = await fixture(t);
  const bytes = Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff, 0x61]);
  const { outcome } = await runner.run(root, {
    command: node(`process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`),
    max_artifact_bytes: 5, max_preview_bytes: 3,
  });
  assert.equal(outcome.stdout.preview, bytes.subarray(0, 3).toString("utf8"));
  assert.equal(outcome.stdout.preview_bytes, 3);
  assert.equal(outcome.stdout.total_bytes, 6);
  assert.equal(outcome.stdout.stored_bytes, 5);
  assert.deepEqual(await fs.readFile(outcome.stdout.path), bytes.subarray(0, 5));
});

test("large simultaneous stdout/stderr drains beyond the bounded retained quotas", async (t) => {
  const { root, runner } = await fixture(t);
  const { outcome } = await runner.run(root, { command: node("process.stdout.write(Buffer.alloc(2000000,120)); process.stderr.write(Buffer.alloc(1700000,101));"), max_artifact_bytes: 2048 });
  assert.equal(outcome.exit_code, 0);
  assert.equal(outcome.stdout.total_bytes, 2000000);
  assert.equal(outcome.stderr.total_bytes, 1700000);
  for (const stream of [outcome.stdout, outcome.stderr]) {
    assert.equal(stream.preview_bytes, 1024);
    assert.equal(stream.stored_bytes, 2048);
    assert.equal((await fs.stat(stream.path)).size, 2048);
    assert.equal(stream.storage_truncated, true);
  }
  const small = await runner.run(root, { command: "printf abcdef", max_artifact_bytes: 2 });
  assert.equal(small.outcome.stdout.preview, "ab");
});

test("explicit log redirection retains full output without masking command failure", async (t) => {
  const { root, runner } = await fixture(t);
  const { outcome } = await runner.run(root, {
    command: `${node("process.stdout.write('x'.repeat(50000)); process.exitCode=9")} > full.log 2>&1; rc=$?; tail -c 8 -- full.log; exit "$rc"`,
    max_artifact_bytes: 16, max_preview_bytes: 8,
  });
  assert.equal(outcome.exit_code, 9);
  assert.equal(outcome.stdout.preview, "xxxxxxxx");
  assert.equal(outcome.stdout.storage_truncated, false);
  assert.equal((await fs.stat(join(root, "full.log"))).size, 50000);
});

test("checked cwd handles literal paths and shell state/stdin are fresh each time", async (t) => {
  const { root, runner } = await fixture(t);
  const relative = "dir with 'quotes'";
  await fs.mkdir(join(root, relative));
  const first = await runner.run(root, { command: "pwd; export POOR_TEST_DOES_NOT_PERSIST=yes; cd /", cwd: relative });
  assert.equal(first.cwd, relative);
  assert.equal(first.outcome.stdout.preview.trim(), join(root, relative));
  const second = await runner.run(root, { command: "printf '%s\n' \"${POOR_TEST_DOES_NOT_PERSIST-unset}\"; pwd; IFS= read -r input; printf 'stdin-status:%s' \"$?\"" });
  assert.equal(second.outcome.stdout.preview, `unset\n${root}\nstdin-status:1`);
});

test("invalid arguments, unsupported env APIs, and unsafe cwd are rejected before spawning", async (t) => {
  const { root, runner, base } = await fixture(t);
  const invalid: unknown[] = [null, [], {}, { command: " " }, { command: "a\0b" }, { command: "é".repeat(65537) },
    { command: "true", env_file: "x" }, { command: "true", env: {} }, { command: "true", session: "x" },
    { command: "true", timeout: 1 }, { command: "true", max_output_bytes: 1 }];
  for (const field of ["timeout_seconds", "max_artifact_bytes", "max_preview_bytes"]) {
    for (const value of [0, -1, 1.5, "1", NaN, Infinity, 67108865]) invalid.push({ command: "true", [field]: value });
  }
  invalid.push({ command: "true", timeout_seconds: 121 }, { command: "true", max_artifact_bytes: 262145 },
    { command: "true", max_artifact_bytes: 4, max_preview_bytes: 5 });
  for (const cwd of [null, "", " ", "/tmp", "..", "a/../b", "./a", "a//b", "a/", "a\\b", "C:/tmp", "a\0b"]) invalid.push({ command: "true", cwd });
  for (const input of invalid) await assert.rejects(runner.run(root, input as BashExecArguments));
  assert.deepEqual(await fs.readdir(base), []);
  await fs.symlink(root, join(root, "link"));
  await fs.writeFile(join(root, "file"), "x");
  for (const cwd of ["link", "link/captures", "file", "missing"]) await assert.rejects(runner.run(root, { command: "true", cwd }));
  assert.deepEqual(await fs.readdir(base), []);
});

test("timeout matches the live reference status and attempts process-group cleanup", async (t) => {
  const { root, runner } = await fixture(t);
  const { outcome } = await runner.run(root, { command: "printf 'timeout probe\n'; sleep 5", timeout_seconds: 1 });
  assert.equal(outcome.timed_out, true);
  assert.equal(outcome.exit_code, null);
  assert.equal(outcome.signal, 15);
  assert.equal(outcome.descendant_cleanup_attempted, true);
  assert.equal(outcome.stdout.preview, "timeout probe\n");
  assert.ok(outcome.duration_ms >= 1000 && outcome.duration_ms < 6000);
});

test("TERM-resistant descendants are killed and do not retain capture pipes", async (t) => {
  const { root, runner } = await fixture(t);
  const { outcome } = await runner.run(root, { command: "trap '' TERM; printf resistant; sleep 30 & wait", timeout_seconds: 1 });
  assert.equal(outcome.timed_out, true);
  assert.equal(outcome.signal, 9);
  assert.equal(outcome.descendant_cleanup_attempted, true);
  assert.equal(outcome.stdout.preview, "resistant");
});

test("a successful shell's leftover background children are request-scoped", async (t) => {
  const { root, runner } = await fixture(t);
  const { outcome } = await runner.run(root, { command: "sleep 30 & printf ready", timeout_seconds: 5 });
  assert.equal(outcome.exit_code, 0);
  assert.equal(outcome.timed_out, false);
  assert.equal(outcome.descendant_cleanup_attempted, true);
  assert.equal(outcome.stdout.preview, "ready");
  assert.ok(outcome.duration_ms < 5000);
});

test("abort before spawn creates no artifacts; cancellation after spawn carries diagnostics", async (t) => {
  const { root, runner, base } = await fixture(t);
  await assert.rejects(runner.run(root, { command: "touch should-not-exist" }, AbortSignal.abort()), /abort/i);
  assert.deepEqual(await fs.readdir(base), []);
  const controller = new AbortController();
  const running = runner.run(root, { command: "printf started; touch ready; sleep 30" }, controller.signal);
  const checked = assert.rejects(running, (error: unknown) => {
    assert.ok(error instanceof BashExecFailure);
    assert.match(error.message, /cancelled/);
    assert.equal(error.result?.outcome.timed_out, false);
    assert.equal(error.result?.outcome.descendant_cleanup_attempted, true);
    assert.equal(error.result?.outcome.stdout.preview, "started");
    return true;
  });
  await waitFile(join(root, "ready"));
  controller.abort();
  await checked;
});

test("spawn failure and artifact write failure throw rather than report command success", async (t) => {
  const { root, base } = await fixture(t);
  const missing = new BashRunner(new CommandArtifacts(base), join(root, "no-such-shell"));
  try { await assert.rejects(missing.run(root, { command: "true" }), /Failed to start bash_exec/); }
  finally { await missing.close(); }
  class BrokenStore extends CommandArtifacts {
    override async begin() {
      const lease = await super.begin();
      lease.stdout.write = (() => Promise.reject(new Error("injected disk failure"))) as typeof lease.stdout.write;
      return lease;
    }
  }
  const broken = new BashRunner(new BrokenStore(base));
  try { await assert.rejects(broken.run(root, { command: "printf x; sleep 10" }), /injected disk failure/); }
  finally { await broken.close(); }
});

test("parallel commands have isolated capture artifacts; close cancels running commands", async (t) => {
  const { root, runner } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runner.run(root, { command: `printf 'output-${i}'; printf 'error-${i}' >&2` })));
  assert.equal(new Set(results.map((r) => r.outcome.command_id)).size, 8);
  for (const [i, r] of results.entries()) {
    assert.equal(r.outcome.stdout.preview, `output-${i}`);
    assert.equal(r.outcome.stderr.preview, `error-${i}`);
  }
  const pending = runner.run(root, { command: "touch close-ready; sleep 30" });
  const rejected = assert.rejects(pending, /cancelled/);
  await waitFile(join(root, "close-ready"));
  await runner.close();
  await rejected;
  await assert.rejects(runner.run(root, { command: "true" }), /closed/);
});

test("retention removes only expired completed owned captures, not live or unrelated files", async (t) => {
  const { root, store, base } = await fixture(t);
  const old = await store.begin();
  await old.stdout.close(); await old.stderr.close(); await old.complete();
  const active = await store.begin();
  await active.stdout.close(); await active.stderr.close();
  const unrelated = join(base, "unrelated");
  await fs.mkdir(unrelated); await fs.writeFile(join(unrelated, "important"), "keep");
  const later = Date.now() + (ARTIFACT_RETENTION_SECONDS + 10) * 1000;
  for (let i = 0; i < 3; i++) await store.cleanup(later);
  await assert.rejects(fs.stat(old.directory), /ENOENT/);
  assert.ok((await fs.stat(active.directory)).isDirectory());
  assert.equal(await fs.readFile(join(unrelated, "important"), "utf8"), "keep");
  assert.ok((await fs.stat(root)).isDirectory());
});
