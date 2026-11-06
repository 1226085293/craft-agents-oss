# Task Workspace UI Redesign

**Date:** 2026-11-06  
**Status:** Approved by the user for implementation.

## Goal

Redesign the task navigator and task detail pane into a clearer, more useful desktop task workspace while preserving the existing task data model, navigation, and lifecycle actions.

## Current UX Problems

- The narrow task list groups `backlog` and `running` together under “进行中”, which hides whether a task has actually started.
- Selection uses a large, saturated accent fill that competes with task text.
- Task rows show only a compressed ID/status/age line and discard the available session count and latest handoff summary.
- The detail pane uses small, uniformly styled text and basic chips, leaving much of the wide content area unused.
- Handoff entries omit available key findings, artifacts, and verification notes.
- The detail pane includes a “关闭” action even in the content-panel mount where it is intentionally a no-op.

## Design Direction

Use a **Task Workspace** layout: preserve the current left navigator and right detail pane. Do not introduce kanban columns, drag-and-drop, new routes, or new task mutations. Keep the existing Craft theme and semantic colors; avoid adding a new palette or external assets.

### Task navigator

- Keep the existing compact panel header and total count.
- Split task groups so `running`, `backlog`, `paused`, and terminal states are unambiguous: “进行中”, “待开始”, “等我拍板”, and “已结束”. Show a per-group count.
- Give the selected row a restrained accent-tinted surface, visible accent edge, and normal foreground text; preserve hover and keyboard focus states.
- Improve row hierarchy: title first; ID, human-readable status, and relative update time as secondary metadata; show session count and the latest handoff summary only when available.
- Keep rows full-width buttons and retain `onSelect` behavior.

### Task detail pane

- Render the content-pane detail as its own full-height view instead of reusing a list component with an absolute overlay.
- Use a clear task heading with human-readable ID, status badge, and paused-only resume/cancel actions. Do not show a no-op close button in the content pane.
- Present the original instruction as readable body text in a distinct section.
- Show compact metric cards for sessions used versus budget, consecutive failures versus fuse threshold, active minutes, and verification verdict when verification is enabled.
- Keep pause reason and last error visible as semantic warning/error callouts.
- Show verification requirement and current verdict when configured.
- Reformat handoffs as a vertical timeline with timestamp, outcome, session, summary, next action, key findings, artifact paths, and verification result/note, conditional on available data.
- Provide a useful empty state when no handoffs exist.
- Keep content scrollable inside the panel; do not introduce nested horizontal scrolling or hide content behind controls.

## Scope and Compatibility

- Preserve the existing `TaskStatus`, `TaskDetailView`, RPC, and task-service contracts.
- Preserve `onResume` and `onCancel` calls and their current paused-only availability.
- Preserve the list navigator close/back behavior supplied by `onCloseDetail` where that callback is meaningful; remove it only from the content-pane-only detail view.
- Use semantic Tailwind/Craft tokens (`background`, `foreground`, `accent`, `info`, `success`, `destructive`, `border`, `muted`) rather than screen-specific hex colors.
- Do not add new external dependencies.
- New display labels may use `t(key, { defaultValue: '…' })`, consistent with the existing task panel.

## Verification and Acceptance

- Add a server-rendered component test for task-list group labels/counts, selected-state classes, metadata, and full detail markup.
- Verify all handoff subfields render when provided and optional sections disappear when absent.
- Verify paused tasks render resume/cancel actions and other statuses do not.
- Run focused renderer tests and Electron typecheck; distinguish any pre-existing errors from regressions.
- Launch the isolated Electron dev instance at the existing multi-agent ports, inspect the task list and detail at desktop panel width, and verify selection, paused actions, scrolling, and rendering exceptions.
