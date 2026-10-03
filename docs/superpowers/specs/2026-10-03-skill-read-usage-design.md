# Skill Read Usage Tracking Design

**Date:** 2026-10-03
**Status:** Awaiting user review before implementation planning

## Goal

Count model-driven, successful native `Read` operations on files inside a skill directory as skill usage, so the Skills list reflects actual skill use even when the model reads `SKILL.md` directly instead of invoking the explicit `Skill` tool.

## Accepted behavior

- Count each successful native `Read` of a file under a recognized skill directory as one use.
- Re-reading the same file counts again. Reading `SKILL.md` and its supporting documents counts each successful read separately.
- Preserve existing explicit `Skill` tool counting and source MCP usage counting.
- Do not count failed `Read` operations, ordinary files, or reads performed through Bash/PowerShell.
- Do not backfill old sessions; tracking starts when the change is deployed.

## Skill roots to recognize

- Global: `~/.agents/skills/<slug>/...`
- Workspace: `<workspaceRoot>/skills/<slug>/...`
- Project: `<workingDirectory>/.agents/skills/<slug>/...`

A read counts only when its path is a file below a skill's directory, not merely a path sharing a textual prefix with a skill root. The slug is the first path segment immediately below the matching skills root.

## Event flow

1. On `tool_start`, retain the `Read` call's original path and tool-use ID, including the complete-input event when the backend emits its two-event pattern.
2. On the matching `tool_result`, recover the original input by `toolUseId` if the result event does not include it.
3. Continue only when the result is successful (`isError !== true`) and the tool is native `Read`.
4. Resolve the file path against the session's effective working directory when it is relative; then match it against the recognized skill roots.
5. Append one `{ kind: 'skill', slug, toolName: 'Read', workspaceId, sessionId }` usage record. Each distinct successful Read result is a distinct record; reuse the existing tool-use deduplication protection where applicable.

## Cross-platform path matching

Normalize both slash styles (`\\` and `/`) before resolving or comparing paths. Use platform-aware absolute-path resolution and segment-based containment (relative-path semantics), not a raw string prefix, so Windows separator variants match and sibling names such as `skills-extra` cannot be mistaken for `skills`. Windows path comparisons are case-insensitive; POSIX comparisons remain case-sensitive. Relative paths resolve against the session working directory, falling back to the workspace root.

## Failure and compatibility

Usage persistence remains best-effort, matching existing `appendUsage` behavior; a tracking failure must not alter the Read tool result or fail the session. No persisted usage schema change is required: existing records already support `kind: 'skill'`, a slug, tool name, workspace ID, session ID, and timestamp.

## Verification

- Unit tests cover global, workspace, and project roots; nested files; both slash styles; Windows case-insensitive matching; relative paths; outside-root and sibling-prefix rejection; and ordinary files.
- Event-flow tests cover success, failure, absent inline result input with tool-use correlation, and repeated reads counting independently.
- Run the usage-store tests, relevant server-core tests, and package type checks; check current and expected failures separately.
