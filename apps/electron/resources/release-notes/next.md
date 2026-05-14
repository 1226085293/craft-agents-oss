# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

## Bug Fixes

- **Clear resets hidden context** — `/clear` now removes persisted Pi backend session state and transient tool artifacts (tool metadata, large tool responses, and turn anchors) as well as Craft's visible message history, preventing Telegram/mobile sessions from recovering stale context after a clear.
- **Telegram progress cleanup** — progress-mode Telegram replies now delay the first transient `💭 thinking…`/tool-status bubble for fast runs and delete any posted progress bubble before sending the final answer, reducing leftover status messages in topics.

## Breaking Changes
