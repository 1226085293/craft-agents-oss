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

Resume ≠ rerun. The evaluator appends a differential message to the **same**
session transcript:

```
[Defense] Detected a possible early stop. Please continue the task from where it left off.
- Write/edit operations were performed but not verified by a read-back. Re-read the affected files...
- Affected targets: ...
- Do NOT repeat already completed steps.
```

Guardrails:
- `maxResumes` (default 3): exceeding → `FAILED`.
- `maxIterations` (default 50) / `maxDurationMs` (default 300_000): exceeding → `ABORTED`.
- Context fingerprint: resuming with the identical resume context twice → `FAILED` (no progress).
