# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

## Improvements

- **Automatic memory extraction now works on Pi-compatible backends** — the auto-extract hooks (compaction + session end) only existed in the Claude agent path, so workspaces using `pi_compat` connections never recorded automatic extractions. Pi agents now extract key facts, preferences, workflows, and reminders the same way, with the per-session dedupe still running one extraction per session.
- **Memory panel shows a readable extraction time** — the last-extraction timestamp is now rendered as local date/time (e.g. `2026/10/01 14:04`) instead of the raw ISO-8601 string.
- **Chat timestamps are selectable** — the date/time shown under assistant replies and user messages is now selectable text, so you can copy the exact timestamp instead of retyping or screenshotting it.
- **Messaging busy replies** — Telegram and WhatsApp bindings can now ask a lightweight agent decision whether an inbound message received during an active run needs an immediate side-channel reply, should be ignored, or should be queued, keeping Telegram's single progress bubble behavior while making long-running chats more responsive.

## Bug Fixes

- **Context-usage ring matches the current model** — after switching connection/model or auto-compaction, the context progress indicator now re-resolves the active model's context window immediately instead of staying stuck on the stale size; prompt tokens written to cache (cacheWrite) now count toward the context size, so the ring no longer under-reports after a /clear, model switch, or compaction.
- **Image preview: opens edge-to-edge with smooth wheel zoom** — the fullscreen image preview now fills the whole viewport on open (cover fit, clamped to the 25%–400% zoom range), so wide or small images no longer sit as a centered strip on the backdrop. Wheel/pinch zoom responds immediately after opening (the listener now survives the portal mount timing), glides smoothly around the pointer instead of jumping per tick, and “Fit to screen” still shows the whole image; drag-to-pan is unchanged.
- **Interrupted and failed runs no longer show a made-up answer** — stopping a run (Stop button or a mid-stream redirect) or hitting an error used to present the last "thinking" text as if it were the reply. Those turns now end with no result on both desktop and mobile, while the commentary stays visible as a process step. A delivered final response is unaffected, and a run that merely ended on a tool call still delivers its message as before.
- **New sessions inherit the current list** — clicking "New session" while viewing a status list (e.g. Backlog) or a concrete label list now creates the session in that same state/label and keeps you in that list, instead of jumping back to All Sessions.
- **Clear resets hidden context** — `/clear` now removes persisted Pi backend session state and transient tool artifacts (tool metadata, large tool responses, and turn anchors) as well as Craft's visible message history, preventing Telegram/mobile sessions from recovering stale context after a clear.
- **Telegram progress cleanup** — progress-mode Telegram replies now delay the first transient `💭 thinking…`/tool-status bubble for fast runs and delete any posted progress bubble before sending the final answer, reducing leftover status messages in topics.

## Breaking Changes

- **User preferences `notes` field removed** — the free-form "Notes" section in Settings → User Preferences (including its AI-assist edit context) and the `notes` argument of the `update_user_preferences` tool have been removed. The system prompt no longer injects "Notes about this user". Legacy `preferences.json` files containing a `notes` key are scrubbed on load; name, timezone, location, and language preferences are unchanged.
