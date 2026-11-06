# Task Workspace UI Redesign Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current isolated `multi-agent` worktree. Use test-first development for the renderer. Preserve unrelated existing worktree changes.

**Goal:** Make the task list and detail pane easier to scan by clarifying lifecycle groups, improving row hierarchy, adding useful task metrics, and rendering handoffs as a complete timeline.

**Architecture:** Keep `TaskBoardPanel` focused on navigator presentation and place the full-width task detail/timeline in `TaskDetailPanelView.tsx`; only the navigator overlay passes an optional close callback. `TaskDetailPanel` composes the detail-only view and preserves existing Task RPC data and callbacks. Reuse Craft semantic theme tokens and Lucide icons.

**Tech Stack:** React, TypeScript, Tailwind utility classes, React server rendering, Bun tests, Electron renderer.

---

### Task 1: Add task-panel rendering regression tests

**Files:**
- Create: `apps/electron/src/renderer/components/tasks/__tests__/TaskBoardPanel.test.tsx`
- Read: `apps/electron/src/renderer/components/tasks/TaskBoardPanel.tsx`
- Read: `apps/electron/src/renderer/components/tasks/TasksPanel.tsx`

- [x] **Step 1: Add fixtures and SSR helpers**

Create typed fixtures for a running task, a paused task, and a detail containing verification, a pause reason, and a handoff with all optional fields. Use `createElement` and `renderToStaticMarkup` like `components/agents/__tests__/agentsSettingsPanel.test.tsx`.

- [x] **Step 2: Add failing assertions**

Cover: separate running/backlog group headings and counts; the selected row has an accent edge and non-solid background; session and latest-handoff metadata appear; detail shows metrics, verification requirement, pause reason, and all handoff fields; paused-only actions render only while paused; detail-only view has no no-op close button.

- [x] **Step 3: Run the focused test and confirm expected failure**

Run from repo root: `bun test apps/electron/src/renderer/components/tasks/__tests__/TaskBoardPanel.test.tsx`.

Expected: failures are missing design markup/labels, not module/config errors.

### Task 2: Improve task-list information hierarchy

**Files:**
- Modify: `apps/electron/src/renderer/components/tasks/TaskBoardPanel.tsx`
- Test: `apps/electron/src/renderer/components/tasks/__tests__/TaskBoardPanel.test.tsx`

- [x] **Step 1: Split groups by actionable lifecycle state**

Use four groups: running, backlog, paused, and terminal (`completed`, `failed`, `canceled`). Filter each group once and render its count beside the heading.

- [x] **Step 2: Refine task rows**

Keep each row as a full-width button. Render title at readable emphasis; show ID, status, age, session count, and optional last handoff in secondary lines. Selected state uses a low-opacity accent surface plus a narrow accent border; retain `hover`, `focus-visible`, selected semantics, and truncation with a `title` for long handoff summaries.

- [x] **Step 3: Run the focused tests**

Run: `bun test apps/electron/src/renderer/components/tasks/__tests__/TaskBoardPanel.test.tsx`.

Expected: all task-list assertions pass; detail-only assertions remain failing.

### Task 3: Build the task detail workspace

**Files:**
- Modify: `apps/electron/src/renderer/components/tasks/TaskBoardPanel.tsx`
- Create: `apps/electron/src/renderer/components/tasks/TaskDetailPanelView.tsx`
- Modify: `apps/electron/src/renderer/components/tasks/TasksPanel.tsx`
- Test: `apps/electron/src/renderer/components/tasks/__tests__/TaskBoardPanel.test.tsx`

- [x] **Step 1: Keep navigator detail overlay behavior**

The left navigator `TaskBoardPanel` may continue rendering selected detail as an overlay and must retain `onCloseDetail` so existing back behavior works.

- [x] **Step 2: Create a dedicated detail view**

Export a detail-only component from the task UI module (or `TasksPanel.tsx`) and render it from `TaskDetailPanel`. Its header contains task name, ID, and status; omit close/back because this is the right panel content. Add paused-only resume/cancel buttons wired to the existing callbacks.

- [x] **Step 3: Add readable summary sections**

Render instruction text as body copy. Add compact responsive metric cards for sessions/budget, consecutive failures/3, active minutes, and verification verdict when enabled. Use semantic badges/callouts for pause reason and last error; show verification requirement where present.

- [x] **Step 4: Render full handoff timeline**

Use a vertical semantic list with timestamp, outcome, source session, summary, next action, key findings, artifact paths/notes, and verify commands/result/note. Render each optional section only when data is present; provide an explicit empty handoff state.

- [x] **Step 5: Run focused tests and Electron typecheck**

Run: `bun test apps/electron/src/renderer/components/tasks/__tests__/TaskBoardPanel.test.tsx`

Run: `cd apps/electron && bun run typecheck`

Result: focused task UI tests pass (7/7 after adding empty-state and navigator-close coverage). Electron-wide typecheck exits non-zero only for the known baseline diagnostics in unrelated files (`handlers/__tests__/registration*.test.ts` missing `labels` module ×2; `SessionList.tsx` `onNewSession` mismatch ×1). No task UI diagnostics were reported in the check. ESLint on all changed task files passes; renderer production build passes.

### Task 4: Visual verification in the isolated app

**Files:** no source changes expected unless visual defects are found.

- [x] **Step 1: Launch/reuse the isolated multi-agent dev instance**

Use `scripts/dev-multi-agent.ps1`; use isolated CDP port 9225 and Vite port 5275. Stop only processes identified by the isolated user-data directory or exact worktree path.

- [x] **Step 2: Inspect task list and detail**

Use CDP to select a task with data and verify the running/backlog/paused/finished group hierarchy, selected row, title, summary metrics, timeline, optional artifact/verification details, and scroll behavior at the app's normal three-panel width.

- [x] **Step 3: Verify interactions and console**

Confirm selecting rows for T-1 and T-2 changes both the route and right-pane title, the list overlay retains its close/back control, paused Resume/Cancel controls appear only for paused tasks (SSR regression coverage) and existing callbacks remain wired, and no new renderer exceptions occur. Do not mutate persisted sample tasks just to create a paused live fixture.

- [x] **Step 4: Final checks**

Run the focused tests, ESLint on changed task UI files, `cd apps/electron && bun run typecheck`, `cd apps/electron && bun run build:renderer`, and `git diff --check`. Typecheck may exit non-zero for the three pre-existing unrelated diagnostics documented above. Preserve and do not stage/commit unrelated event changes or `scripts/verify-ui-5fixes.mjs`.
