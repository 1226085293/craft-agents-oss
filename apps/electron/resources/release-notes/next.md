# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

## Improvements

- **Messaging busy replies** — Telegram and WhatsApp bindings can now ask a lightweight agent decision whether an inbound message received during an active run needs an immediate side-channel reply, should be ignored, or should be queued, keeping Telegram's single progress bubble behavior while making long-running chats more responsive.

## Bug Fixes

- **Interrupted and failed runs no longer show a made-up answer** — stopping a run (Stop button or a mid-stream redirect) or hitting an error used to present the last "thinking" text as if it were the reply. Those turns now end with no result on both desktop and mobile, while the commentary stays visible as a process step. A delivered final response is unaffected, and a run that merely ended on a tool call still delivers its message as before.
- **New sessions inherit the current list** — clicking "New session" while viewing a status list (e.g. Backlog) or a concrete label list now creates the session in that same state/label and keeps you in that list, instead of jumping back to All Sessions.
- **Clear resets hidden context** — `/clear` now removes persisted Pi backend session state and transient tool artifacts (tool metadata, large tool responses, and turn anchors) as well as Craft's visible message history, preventing Telegram/mobile sessions from recovering stale context after a clear.
- **Telegram progress cleanup** — progress-mode Telegram replies now delay the first transient `💭 thinking…`/tool-status bubble for fast runs and delete any posted progress bubble before sending the final answer, reducing leftover status messages in topics.

## Breaking Changes
