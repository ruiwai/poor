import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { buildPoorSystemPrompt, SHADOWED_TOOLS } from "../src/prompt.ts";

const legacy = "LEGACY BASE: Use read, bash, edit and write. This custom base is replaced.";
const project = "Preserve project policy verbatim; identifiers may be named read, write, edit or bash.";
const userAppend = "Follow the explicit release checklist and keep user-facing behavior stable.";

async function fixture(t: TestContext, selection: Pick<CreateAgentSessionOptions, "tools" | "noTools"> = {}, custom = false) {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-prompt-test-"));
  const agentDir = join(root, "agent");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "skills", "audit", "SKILL.md");
  await fs.mkdir(join(root, "skills", "audit"), { recursive: true });
  await fs.writeFile(path, "---\nname: audit\ndescription: Test full prompt assembly.\n---\nAudit instructions.\n");
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    additionalSkillPaths: [path], noContextFiles: true, noThemes: true, noPromptTemplates: true,
    systemPrompt: custom ? legacy : undefined,
    appendSystemPrompt: [userAppend],
    agentsFilesOverride: () => ({ agentsFiles: [{ path: join(root, "AGENTS.md"), content: project }] }),
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), ...selection,
  });
  assert.deepEqual(extensionsResult.errors, []);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const rewrite = async (base = session.agent.state.systemPrompt, options?: BuildSystemPromptOptions) => {
    const current = options ?? session.extensionRunner.createCommandContext().getSystemPromptOptions();
    const result = await session.extensionRunner.emitBeforeAgentStart("Test only.", undefined, base, current);
    assert.deepEqual(errors, []);
    assert.ok(result?.systemPrompt);
    return result.systemPrompt;
  };
  return { root, session, rewrite };
}

test("complete prompt replaces Pi's old base, rather than appending or editing its tool section", async (t) => {
  const { root, session, rewrite } = await fixture(t);
  const before = session.agent.state.systemPrompt;
  assert.match(before, /Pi documentation/);
  const after = await rewrite(before + "\nEARLIER EXTENSION BASE TEXT");
  assert.match(after, /^You are a coding agent operating in a local development workspace/);
  assert.doesNotMatch(after, /Pi documentation|EARLIER EXTENSION BASE TEXT|expert coding assistant operating inside pi/);
  assert.match(after, /- bash_exec:/);
  assert.match(after, /- apply_patch:/);
  assert.doesNotMatch(after, /^- (bash|read|write|edit):/m);
  assert.equal(after.split("## bash_exec:").length - 1, 1);
  assert.equal(after.split("## apply_patch:").length - 1, 1);
  assert.ok(after.endsWith(`Current working directory: ${root}`));
  assert.equal(await rewrite(after), after);
});

test("custom SYSTEM.md base is replaced even without markers; structured context is preserved", async (t) => {
  const { rewrite } = await fixture(t, {}, true);
  const after = await rewrite();
  assert.doesNotMatch(after, /LEGACY BASE|poor:tools:/);
  assert.equal(after.split(project).length - 1, 1);
  assert.equal(after.split(userAppend).length - 1, 1);
  assert.equal(after.split("<available_skills>").length - 1, 1);
  assert.match(after, /use bash_exec to read its SKILL\.md/);
  assert.doesNotMatch(after, /Use the read tool to load|Use bash to load/);
});

for (const active of [["bash_exec"], ["apply_patch"], ["grep"], ["bash_exec", "grep"], []]) {
  test(`full prompt instructions follow actual active tools ${JSON.stringify(active)}`, async (t) => {
    const { session, rewrite } = await fixture(t);
    session.setActiveToolsByName(active);
    const after = await rewrite();
    assert.deepEqual(session.getActiveToolNames(), active);
    assert.equal(after.includes("## bash_exec:"), active.includes("bash_exec"));
    assert.equal(after.includes("## apply_patch:"), active.includes("apply_patch"));
    assert.equal(after.includes("use bash_exec to read its SKILL.md"), active.includes("bash_exec"));
    assert.equal(after.includes("## Mutation limitation"), !active.includes("apply_patch"));
    assert.ok(after.includes(project));
    if (!active.length) assert.match(after, /No tools are currently active/);
    assert.equal(await rewrite(after), after);
  });
}

test("reactivated original tools and stale prompt options cannot reintroduce their instructions", async (t) => {
  const { session, rewrite } = await fixture(t);
  session.setActiveToolsByName(["read", "write", "edit", "bash", "bash_exec", "apply_patch"]);
  const stale = session.extensionRunner.createCommandContext().getSystemPromptOptions();
  const base = session.agent.state.systemPrompt;
  assert.match(base, /Use the read tool to load/);
  const after = await rewrite(base, stale);
  assert.deepEqual(session.getActiveToolNames().sort(), ["apply_patch", "bash_exec"]);
  assert.doesNotMatch(after, /Use the read tool to load|Use bash to load|edits\[\]\.oldText/);
  assert.match(after, /use bash_exec to read its SKILL\.md/);
});

test("new prompt explains stream counters, retained prefixes, redirection and failure semantics", () => {
  const prompt = buildPoorSystemPrompt({ cwd: "/workspace" }, ["bash_exec", "apply_patch"]);
  for (const field of ["exit_code", "timed_out", "descendant_cleanup_attempted", "preview_bytes", "stored_bytes", "total_bytes", "storage_truncated", "preview_truncated"]) assert.ok(prompt.includes(field), field);
  assert.match(prompt, /Reading the artifact cannot recover discarded output/);
  assert.match(prompt, /tail -n 60/);
  assert.match(prompt, /exit "\$status"/);
  assert.match(prompt, /NOT sandboxed/);
  assert.match(prompt, /multi-file changes and moves are NOT atomic/);
  assert.match(prompt, /There is no session, env_file, environment-map, or persistent-shell API/);
});

test("project bodies are preserved, metadata is escaped, and stale generic prompt guidelines are discarded", () => {
  const content = "```\n<available_skills>literal example</available_skills>\nread write edit bash";
  const prompt = buildPoorSystemPrompt({
    cwd: "/workspace", customPrompt: "obsolete",
    contextFiles: [{ path: '/workspace/a"<&', content }],
    promptGuidelines: ["Use old read and bash tools"], appendSystemPrompt: "Explicit user instructions.",
  }, ["grep", "read", "bash", "grep"], [{ name: "grep", description: "Search source", promptGuidelines: ["Use bounded searches."] }]);
  assert.ok(prompt.includes(content));
  assert.match(prompt, /path="\/workspace\/a&quot;&lt;&amp;"/);
  assert.doesNotMatch(prompt, /Use old read and bash tools/);
  assert.equal(prompt.split("- grep:").length - 1, 1);
  assert.match(prompt, /Use bounded searches/);
  assert.deepEqual([...SHADOWED_TOOLS].sort(), ["bash", "edit", "read", "write"]);
});
