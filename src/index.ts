import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatch, PatchFailure } from "./apply-patch.ts";
import { LIMITS } from "./patch.ts";
import { BASH_SNIPPET, PATCH_SNIPPET, buildPoorSystemPrompt, SHADOWED_TOOLS } from "./prompt.ts";
import { BashRunner, bashParameters } from "./bash-exec.ts";

export { SHADOWED_TOOLS } from "./prompt.ts";

export const patchParameters = Type.Object({
  patch: Type.Unsafe<string>({
    type: "string", minLength: 1, "x-maxUtf8Bytes": LIMITS.maxPatchBytes,
    description: "Complete exact-only Codex patch document with ordered hunks; maximum UTF-8 size is 33554432 bytes.",
  }),
}, { additionalProperties: false });

function disabledReason(name: string): string {
  return `${name} is disabled by poor; use ${name === "read" || name === "bash" ? "bash_exec for inspection and commands" : "apply_patch for file changes"} when that replacement is active.`;
}

export default function poor(pi: ExtensionAPI): void {
  const shell = new BashRunner();
  pi.registerTool({
    name: "bash_exec",
    label: "Bash Exec",
    description: "Run one fresh non-interactive bash -c with host permissions from an arbitrary host cwd (relative paths use the session cwd). "
      + "Not a sandbox; stdin is closed and shell state does not persist. No env_file, persistent environment, or session argument. "
      + "Collect stdout/stderr into separate private artifacts and return one JSON result with bounded previews, compact length counters, "
      + "and artifact paths; output beyond the retained quota is silently discarded. Defaults/caps: 120 seconds, 64 MiB retained bytes per "
      + "stream; default preview 1024 bytes. Timeout defaults to 120 seconds and may be set up to 7 days. Preview must not exceed artifact quota. Tool success is not command success: "
      + "inspect exit_code, signal, timed_out and descendant_cleanup_attempted. Excess output is drained but not retained. "
      + "Redirect large logs explicitly to workspace files. Artifacts have best-effort seven-day retention. "
      + "Commands are request-scoped; timeout, cancellation and leftover descendants trigger process-group cleanup.",
    promptSnippet: BASH_SNIPPET,
    parameters: bashParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await shell.run(ctx.cwd, params, signal);
      // A single bounded response, not repeated streaming snapshots of a log.
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.on("session_shutdown", async () => { await shell.close(); });
  // Real overrides: even accidental reactivation cannot reach the originals.
  for (const name of SHADOWED_TOOLS) {
    const reason = disabledReason(name);
    pi.registerTool({
      name,
      label: `${name} (disabled)`,
      description: reason,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute() { throw new Error(reason); },
      // Do not inherit renderers expecting the original tools' argument shapes.
      renderCall: () => ({ render: () => [`${name} (disabled)`], invalidate() {} }),
      renderResult: () => ({ render: () => [reason], invalidate() {} }),
    });
  }

  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply an exact Codex patch locally, relative to the current working directory. "
      + "The patch must begin with '*** Begin Patch' and end with '*** End Patch'. "
      + "Use '*** Add File: path' with '+' lines; '*** Delete File: path'; or "
      + "'*** Update File: path' with an optional '*** Move to: path' followed by hunks. "
      + "Start each hunk with '@@' or '@@ <exact locator line>'; prefix context with ' ', deletions with '-', additions with '+'. "
      + "'*** End of File' anchors the preceding hunk at EOF. Pure insertions append. "
      + "Paths must be normalized, cwd-relative, non-Git, non-symlink paths. "
      + "Preflight checks all operations; moves and multi-file patches are NOT atomic and later failure only attempts compensation. "
      + "Limits: 32 MiB patch, 128 operations, 4 MiB per file, 32 MiB retained file content. "
      + "Example: *** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch",
    promptSnippet: PATCH_SNIPPET,
    parameters: patchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Pi normally validates the schema; also protect direct SDK invocations.
      if (!params || typeof params.patch !== "string" || Object.keys(params).some((key) => key !== "patch")) {
        throw new Error("apply_patch accepts exactly one argument: { patch: string }");
      }
      try {
        const result = await applyPatch(ctx.cwd, params.patch, signal);
        const summary = result.files.map((file) => {
          const marker = { added: "A", updated: "M", deleted: "D", moved: "R" }[file.action];
          return `${marker} ${file.previous_path ? `${file.previous_path} -> ` : ""}${file.path}`;
        }).join("\n");
        return { content: [{ type: "text", text: `Success. Updated the following files:\n${summary}` }], details: result };
      } catch (error) {
        // Pi marks thrown errors as failures; returned { isError: true } would
        // not do that. Include recovery facts in the model-visible error text.
        if (error instanceof PatchFailure) {
          throw new Error(`${error.message}\nPatch diagnostics: ${JSON.stringify(error.diagnostics)}`, { cause: error });
        }
        throw error;
      }
    },
  });

  const hideOriginals = (replaceDefaults = false): void => {
    const active = pi.getActiveTools();
    const next = active.filter((name) => !SHADOWED_TOOLS.has(name));
    if (replaceDefaults && active.includes("bash") && !next.includes("bash_exec")) next.push("bash_exec");
    if (replaceDefaults && active.some((name) => name === "write" || name === "edit") && !next.includes("apply_patch")) {
      next.push("apply_patch");
    }
    if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
  };

  pi.on("session_start", async () => { hideOriginals(true); });
  pi.on("session_tree", async () => { hideOriginals(); });
  pi.on("turn_start", async () => { hideOriginals(); });
  let warnedCustomPrompt = false;
  pi.on("before_agent_start", async (event, ctx) => {
    // Replacement is intentional: discard the old base, not append or regex-edit it.
    // Never re-enable tools disabled after startup by the user or another extension.
    hideOriginals();
    if (event.systemPromptOptions.customPrompt && !warnedCustomPrompt) {
      warnedCustomPrompt = true;
      const warning = "poor owns the complete base prompt, replacing SYSTEM.md/--system-prompt. Project context and explicit append instructions are preserved.";
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.error(warning);
    }
    return { systemPrompt: buildPoorSystemPrompt(event.systemPromptOptions, pi.getActiveTools(), pi.getAllTools()) };
  });
  pi.on("tool_call", async (event) => {
    if (SHADOWED_TOOLS.has(event.toolName)) return { block: true, reason: disabledReason(event.toolName) };
  });
}
