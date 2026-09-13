import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

async function load(t: TestContext, options: Pick<CreateAgentSessionOptions, "tools" | "noTools"> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-pi-test-"));
  const agentDir = join(root, "agent");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), ...options,
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  assert.deepEqual(extensionsResult.errors, []);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  assert.deepEqual(errors, []);
  return { root, session };
}

test("real Pi loader activates only bash_exec and apply_patch by default", async (t) => {
  const { session } = await load(t);
  assert.deepEqual(session.getActiveToolNames().sort(), ["apply_patch", "bash_exec"]);
  const registered = session.extensionRunner.getAllRegisteredTools();
  assert.deepEqual(registered.map((tool) => tool.definition.name).sort(), ["apply_patch", "bash", "bash_exec", "edit", "read", "write"]);
  const definition = session.extensionRunner.getToolDefinition("apply_patch")!;
  const schema = JSON.parse(JSON.stringify(definition.parameters)) as {
    properties: { patch: { minLength: number; maxLength: number } };
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties), ["patch"]);
  assert.deepEqual(schema.required, ["patch"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.patch.minLength, 1);
  assert.equal(schema.properties.patch.maxLength, 33_554_432);
});

test("Pi-wrapped apply_patch executes in session cwd, not extension install directory", async (t) => {
  const { root, session } = await load(t);
  const tool = session.agent.state.tools.find((tool) => tool.name === "apply_patch")!;
  const result = await tool.execute("test-call", {
    patch: "*** Begin Patch\n*** Add File: hello.txt\n+hello from Pi\n*** End Patch",
  });
  assert.equal(await fs.readFile(join(root, "hello.txt"), "utf8"), "hello from Pi\n");
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /A hello.txt/);
  const definition = session.extensionRunner.getToolDefinition("apply_patch")!;
  await assert.rejects(definition.execute("invalid", { patch: "x", session: "must-not-be-used" }, undefined, undefined, session.extensionRunner.createContext()), /exactly one argument/);
  await assert.rejects(tool.execute("mismatch", {
    patch: "*** Begin Patch\n*** Update File: hello.txt\n@@\n-missing\n+x\n*** End Patch",
  }), /Patch diagnostics:.*unchanged/);
});

test("original tools remain blocked even if another extension reactivates them", async (t) => {
  const { root, session } = await load(t);
  await fs.writeFile(join(root, "note"), "unchanged\n");
  session.setActiveToolsByName(["read", "write", "edit", "bash", "bash_exec", "apply_patch", "grep"]);
  for (const name of ["read", "write", "edit", "bash"]) {
    const blocked = await session.extensionRunner.emitToolCall({
      type: "tool_call", toolName: name, toolCallId: `blocked-${name}`,
      input: { path: "note", content: "bad", oldText: "unchanged", newText: "bad" },
    });
    assert.equal(blocked?.block, true);
    const definition = session.extensionRunner.getToolDefinition(name)!;
    await assert.rejects(definition.execute("direct", {}, undefined, undefined, session.extensionRunner.createContext()), /disabled by poor/);
  }
  await session.extensionRunner.emit({ type: "turn_start", turnIndex: 1, timestamp: Date.now() });
  assert.deepEqual(session.getActiveToolNames().sort(), ["apply_patch", "bash_exec", "grep"]);
  assert.equal(await fs.readFile(join(root, "note"), "utf8"), "unchanged\n");
});

test("read-only tool selections are not turned back into mutation-enabled sessions", async (t) => {
  const { root, session } = await load(t);
  session.setActiveToolsByName(["bash_exec", "grep"]);
  await session.extensionRunner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  const result = await session.extensionRunner.emitBeforeAgentStart("test", undefined, "Custom prompt.", {
    cwd: root, selectedTools: session.getActiveToolNames(), customPrompt: "Custom prompt.",
  });
  assert.deepEqual(session.getActiveToolNames().sort(), ["bash_exec", "grep"]);
  assert.match(result?.systemPrompt ?? "", /Runtime instruction profile: poor\/2/);
  assert.doesNotMatch(result?.systemPrompt ?? "", /Custom prompt\.|## apply_patch: file changes/);
});

test("explicit old-tool allowlists are not bypassed; new-tool-only and no-tools selections are respected", async (t) => {
  const { session: bashOnly } = await load(t, { tools: ["bash"] });
  // Pi's allowlist excludes the new name. Do not bypass it: select bash_exec explicitly.
  assert.deepEqual(bashOnly.getActiveToolNames(), []);
  const { session: noTools } = await load(t, { noTools: "all" });
  assert.deepEqual(noTools.getActiveToolNames(), []);
  const { session: shellOnly } = await load(t, { tools: ["bash_exec"] });
  assert.deepEqual(shellOnly.getActiveToolNames(), ["bash_exec"]);
  const { session: patchOnly } = await load(t, { tools: ["apply_patch"] });
  assert.deepEqual(patchOnly.getActiveToolNames(), ["apply_patch"]);
});

test("Pi-wrapped bash_exec returns one structured clump and exposes no environment API", async (t) => {
  const { root, session } = await load(t);
  const tool = session.agent.state.tools.find((tool) => tool.name === "bash_exec")!;
  let updates = 0;
  const result = await tool.execute("shell-test", {
    command: "pwd; printf err >&2; exit 6", max_preview_bytes: 1024,
  }, undefined, () => { updates++; });
  assert.equal(updates, 0);
  assert.equal(result.content.length, 1);
  const decoded = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "null");
  assert.deepEqual(result.details, decoded);
  assert.equal(decoded.outcome.exit_code, 6);
  assert.equal(decoded.outcome.stdout.preview, `${root}\n`);
  assert.equal(decoded.outcome.stderr.preview, "err");
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.env_file, undefined);
  assert.equal(schema.properties.session, undefined);
  await assert.rejects(tool.execute("invalid-env", { command: "true", env_file: "x" }), /Unknown bash_exec argument/);
  assert.equal(session.getAllTools().some((tool) => tool.name === "store_cmd_env"), false);
});
