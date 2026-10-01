# Defense Module — Early-Stop Protection

Anti early-stop defense for the Pi agent server. Addresses the ~10% early-stop
problem where the agent stops before completing all goal checklist items.

## Architecture (2 layers)

| Layer | Module | Responsibility |
|---|---|---|
| **L1** | `system-discipline.ts` | Execution-discipline block appended to the effective system prompt: goal-checklist self-check before `finish`, actions-before-words, failure fallback, artifact read-back verification, balanced wrap-up. |
| **L2** | `complexity-score.ts` | Side-effect-weighted scoring of tool calls (`read 0.5 / bash:read 0.8 / edit 1.5 / write 2.0 / bash:write 3.0`). `hasWrite && !hasVerify` (wrote but never read back) is the strongest early-stop signal. |
| **L2** | `repetition-detector.ts` | Degeneration-loop detection. Flags a final assistant reply whose sampled content is >60% exact duplicates (line-level and sliding-window chunk strategies) — the 2026-08-28 incident (213K chars = 874 copies of one sentence) carried visible text and sailed past empty-response/silent-stop detection. Conservatively gated to avoid false positives on code dumps and recurring idioms. |
| **L2** | `session-lifecycle.ts` | Finite state machine (`IDLE → RUNNING → EVALUATING → RESUME_READY → RESUMING → DONE/FAILED/ABORTED`) with resume guardrails: max resume count, max iterations, max duration, and a context-fingerprint no-progress check. |

**Empty terminal response** (extracted in `index.ts`, passed to the
evaluator): any clean stop (`stop` or `length`) whose FINAL assistant
message carries no visible text block — empty content, or thinking-only
content whose reasoning is invisible to the user (2026-08-22 gateway
fault, 2026-08-28 truncation, 2026-10-01 incidents `261001-ready-sunset`
/ `261001-calm-pond` where a clean stop ended on a thinking block only).

> **Removed — Layer 3 `idle-words.ts`.** The idle-word regex produced false
> positives on normal transition sentences (e.g. "现在修改现有的集成点：") because
> regex matches word surfaces, not semantics. Per issue #1 it is deleted and its
> responsibilities absorbed into L1 (planning-language discipline) and L2
> (side-effect-weighted scoring), which do not touch semantics.

## Master switch

`defenseEnabled: boolean` in the **init message**, controlled by the user.

- `true` (default when omitted): `DefenseEvaluator` is created and L1 discipline
  is applied.
- `false`: no evaluator is created; `defenseReset()` yields `null`; L1 discipline
  is not appended.

L1 and L2 are both gated by this single switch — there are no sub-policies.

## Integration points

- `index.ts::handleInit` — reads `msg.defenseEnabled`, stores `defenseEnabled`
  flag and calls `defenseReset()`.
- `index.ts::defenseReset()` — creates a `DefenseEvaluator` only when the flag is
  enabled; otherwise clears it.
- `index.ts::handlePrompt` — applies `withExecutionDiscipline()` when enabled;
  wires tool events into the evaluator; on `agent_end` runs post-stop evaluation
  and queues a resume via `session.followUp()` when early-stop is suspected.
- `system-prompt-override.ts` — exports `withExecutionDiscipline()`.

## Resume semantics

Resume ≠ rerun. The evaluator appends a **verification delivery** step to the
**same** session transcript. The model judges whether its final reply (its
last assistant message) actually corresponds to the user's message — the
resumed turn stays inside the same turn's process block (the main process
holds its event queue open via `defenseResumePending`, see
`event-adapter.ts`):

```
[Defense] Verification delivery step — check delivery, do NOT re-run the task.
Judge whether your final reply (your last assistant message in this conversation)
corresponds to the user's message (the request the user sent in this turn):
- If it DOES correspond: your reply now must simply be that final reply content,
  verbatim — the same reply from before this verification step. Add no new analysis,
  redo no completed work, append no new steps.
- If it does NOT correspond (missing, off-target, or unverified): state the reason
  in one short line, then continue the task from where it left off.
Signals that triggered this verification step:
- <per-signal lines: writes without read-back / empty response / repetition loop / …>
- Do NOT repeat already completed steps.
```

The "does correspond" branch re-delivers the previous final reply verbatim, so
the user effectively receives ONE reply — not a second, different one. Extra
work happens only on the "does not correspond" branch (reason + continue).

**UI rendering of the resumed reply** (2026-10-01, `event-adapter.ts`):
while a held defense-resume window is open, the resumed turn's final `stop`
reply is the verification-delivery step, not a new top-level reply. The
adapter folds it into the **process block** instead of a second reply card by
marking it `isIntermediate`, with ONE discriminator:
- **No tool executed** in the window → pure "corresponds → re-deliver"
  duplicate of the original reply → `isIntermediate=true` (process-block step).
- **A tool DID execute** → "doesn't correspond → continue"; the reply is the
  continuation's NEW answer → `isIntermediate=false` (stays a visible card).

This is persisted in `session.jsonl`, so a reload renders the same view as the
live stream. The main turn's reply (emitted before the hold) always stays a
normal reply card.

Guardrails:
- `maxResumes` (default 3): exceeding → `FAILED`.
- `maxIterations` (default 50) / `maxDurationMs` (default 300_000): exceeding → `ABORTED`.
- Context fingerprint: resuming with the identical resume context twice → `FAILED` (no progress).
