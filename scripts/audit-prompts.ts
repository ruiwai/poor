/** Inspect real Pi prompt assembly using synthetic context; never calls a model. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

const sdk = await import(process.env.POOR_PI_SDK
  ? pathToFileURL(resolve(process.env.POOR_PI_SDK)).href
  : "@earendil-works/pi-coding-agent") as typeof import("@earendil-works/pi-coding-agent");
const entry = process.env.POOR_EXTENSION_ENTRY ?? fileURLToPath(new URL("../src/index.ts", import.meta.url));
const out = resolve(process.argv[2] ?? "artifacts/bash-prompt-audit");
const verify = process.argv.includes("--verify");
const context = "Keep project-specific instructions verbatim. Example identifiers: read, write, edit.";
const userAppend = "Preserve this explicit release-checklist requirement.";
const custom = "Custom persona, unchanged.\n\n<!-- poor:tools:start -->\nUse read to inspect files; use write and edit to change files.\n<!-- poor:tools:end -->\n\nKeep this custom footer.";
const cases: Array<{ name: string; options?: Pick<CreateAgentSessionOptions, "tools" | "noTools">; custom?: string; reactivate?: boolean; extension?: boolean }> = [
  { name: "native", extension: false },
  { name: "default" },
  { name: "shell-only", options: { tools: ["bash_exec"] } },
  { name: "legacy-bash-allowlist", options: { tools: ["bash"] } },
  { name: "grep-only", options: { tools: ["grep"] } },
  { name: "no-tools", options: { noTools: "all" } },
  { name: "patch-only", options: { tools: ["apply_patch"] } },
  { name: "reactivated", reactivate: true },
  { name: "custom-marked", custom },
  { name: "custom-unmarked", custom: "Custom instructions without a managed tool section. Preserve exactly." },
];
const records = [];
for (const fixture of cases) {
  const root = await fs.mkdtemp(join(tmpdir(), "poor-prompt-audit-"));
  let session: Awaited<ReturnType<typeof sdk.createAgentSession>>["session"] | undefined;
  try {
    const agentDir = join(root, "agent");
    const skillPath = join(root, "skills", "fixture", "SKILL.md");
    await fs.mkdir(dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "---\nname: audit-fixture\ndescription: Synthetic prompt audit.\n---\nSynthetic skill.\n");
    const settingsManager = sdk.SettingsManager.inMemory();
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      additionalExtensionPaths: fixture.extension === false ? [] : [entry],
      additionalSkillPaths: [skillPath],
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: fixture.custom,
      appendSystemPrompt: [userAppend],
      agentsFilesOverride: () => ({ agentsFiles: [{ path: join(root, "AGENTS.md"), content: context }] }),
    });
    await loader.reload();
    const loaded = await sdk.createAgentSession({
      cwd: root, agentDir, settingsManager, resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(root), ...fixture.options,
    });
    session = loaded.session;
    assert.deepEqual(loaded.extensionsResult.errors, []);
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    if (fixture.reactivate) session.setActiveToolsByName(["read", "edit", "write", "bash", "bash_exec", "apply_patch", "grep"]);
    const base = session.agent.state.systemPrompt;
    const options = session.extensionRunner.createCommandContext().getSystemPromptOptions();
    const result = await session.extensionRunner.emitBeforeAgentStart("Audit only.", undefined, base, options);
    const after = result?.systemPrompt ?? base;
    const again = await session.extensionRunner.emitBeforeAgentStart("Audit twice.", undefined, after, options);
    assert.deepEqual(errors, []);
    const active = session.getActiveToolNames();
    const normalize = (value: string) => value.split(root).join("<workspace>");
    const summary = {
      name: fixture.name, active,
      fullReplacement: after.includes("Runtime instruction profile: poor/2"),
      hasShellInstructions: after.includes("## bash_exec:"),
      hasPatchInstructions: after.includes("## apply_patch:"),
      staleSkillReader: /Use the read tool to load|Use bash to load/.test(after),
      legacyBaseAbsent: !fixture.custom || !after.includes(fixture.custom),
      idempotent: (again?.systemPrompt ?? after) === after,
      projectContextPreserved: after.includes(context),
      userAppendPreserved: after.includes(userAppend),
    };
    if (verify && fixture.extension !== false) {
      assert.equal(summary.fullReplacement, true, fixture.name);
      assert.equal(summary.hasShellInstructions, active.includes("bash_exec"), fixture.name);
      assert.equal(summary.hasPatchInstructions, active.includes("apply_patch"), fixture.name);
      assert.equal(summary.staleSkillReader, false, fixture.name);
      assert.equal(summary.legacyBaseAbsent, true, fixture.name);
      assert.equal(summary.idempotent, true, fixture.name);
      assert.equal(summary.projectContextPreserved, true, fixture.name);
      assert.equal(summary.userAppendPreserved, true, fixture.name);
      assert.doesNotMatch(after, /^- (read|write|edit|bash):/m);
      const shell = session.extensionRunner.getToolDefinition("bash_exec");
      assert.ok(shell);
      const schema = JSON.parse(JSON.stringify(shell.parameters));
      assert.equal(schema.properties.env_file, undefined);
      assert.equal(schema.properties.session, undefined);
      if (fixture.name === "default") assert.deepEqual([...active].sort(), ["apply_patch", "bash_exec"]);
    }
    records.push({ ...summary, base: normalize(base), after: normalize(after) });
    console.log(JSON.stringify(summary));
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
await fs.mkdir(dirname(out), { recursive: true });
await fs.writeFile(`${out}.json`, JSON.stringify(records, null, 2) + "\n");
const normal = records.find((record) => record.name === "default")!;
await fs.writeFile(`${out}.md`, `# Default Pi prompt audit\n\n## Assembled base\n\n\`\`\`text\n${normal.base}\n\`\`\`\n\n## After extension hook\n\n\`\`\`text\n${normal.after}\n\`\`\`\n`);
console.log(`Snapshots: ${out}.{json,md}`);
