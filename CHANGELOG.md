# Changes

## 2.0.0

- Replace the built-in bash tool with local workspace-mcp-style `bash_exec`.
- Return bounded stdout/stderr previews, retained artifact paths, compact
  `shown/observed` byte counters, and command outcome metadata. Empty streams
  are `null`; legacy per-stream truncation fields are not part of the schema.
- Add request-scoped process-group cleanup, cancellation, and best-effort
  seven-day private artifact retention. No environment-file or persistent-env API.
- Replace the entire base system prompt with a purpose-built instruction profile
  for `bash_exec`, `apply_patch`, active tools, output handling and skill loading.
- Preserve structured project context and explicit append instructions; replace
  custom SYSTEM.md bases and remove the old marker/target-replacement mechanism.
- Respect explicit Pi tool allowlists; select new names rather than `bash`.

The exact-only patch engine and its existing behavior remain unchanged.
