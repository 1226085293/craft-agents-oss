# Event Center

External events (mail, GitHub, page changes…) land in Craft, get stored, and can
wake agent sessions that subscribed to them.

Two halves:

- **ingest** — a loopback HTTP endpoint listeners POST to,
- **listeners** — user scripts Craft supervises, declared by a manifest.

## Writing a listener

```
<workspace>/events/<listenerId>/
├── manifest.json      # required
├── listener.py        # your program
└── README.md          # optional
```

Runtime data (logs, payloads, enabled flags) lives in
`<workspace>/events-data/<listenerId>/`, so the code directory stays clean and
git-friendly.

### manifest.json

```json
{
  "spec": "craft-listener/1",
  "id": "qqmail-idle",
  "name": "QQ 邮箱",
  "version": "1.2.0",
  "description": "监听 QQ 邮箱新邮件",

  "runtime": {
    "program": ["python", "-u", "${dir}/listener.py"],
    "readyTimeoutMs": 20000,
    "restart": { "policy": "on-failure", "maxAttempts": 5 }
  },

  "dependencies": {
    "packages": [{ "manager": "pip", "name": "imapclient", "range": "^3.0" }],
    "mcp": [
      { "id": "mail-tools", "mode": "managed", "source": "npm", "package": "mail-mcp", "version": "^1.2.0" },
      { "id": "corp-remote", "mode": "remote", "url": "https://mcp.example.com/sse", "auth": "oauth" }
    ]
  },

  "config": {
    "properties": {
      "email": { "type": "string", "title": "邮箱地址" },
      "authCode": { "type": "string", "title": "授权码", "secret": true }
    },
    "required": ["email", "authCode"]
  },

  "setup": [{ "text": "网页版开启 IMAP/SMTP 并生成授权码", "link": "https://service.mail.qq.com/detail/0/1087" }]
}
```

`program` **must** be an argv array. A single string like `"python a.py"` is
rejected on purpose: it would reintroduce shell semantics.

Placeholders: `${dir}` (listener dir), `${data}` (its data dir).

Version ranges use an npm subset: `*`, `2.*`, `^1.2.3`, `~1.2.3`,
`>=3.9 <4`, `1.2.3`, and `||` for alternatives. Names and ranges are
validated against CLI-safe charsets (they land inside fixed install
commands), so values like `"-r /etc/passwd"` are rejected at parse time.

### Dependencies

Three kinds, split by "who can verify it":

- **`packages`** (pip/npm) — Craft probes and installs them (detail page
  button).
- **`mcp`** — MCP servers the listener talks to. `mode: "managed"` servers
  are installed **by Craft** into `<workspace>/mcp/<id>/` (never by the
  listener — the install location must stay visible and uninstallable);
  install runs before the listener can be considered ready, with a button on
  the detail page when missing. `mode: "remote"` servers are URLs only —
  nothing to install. Handing the MCP *connection* to the listener process is
  a separate, future piece.
- **reported dependencies** — everything Craft cannot verify reliably (arbitrary
  executables, system components, licenses). The listener may run a loopback
  HTTP **control service** and report its own dependency state; Craft only
  renders it and forwards button presses. Contract (`craft-deps/1`):

  - bind `127.0.0.1` on an ephemeral port, generate a random token, and write
    `<dataDir>/control.json` as `{ "port", "token", "pid" }` (mode 600);
  - `GET /deps` → `{ "deps": [...] }` where each entry is
    `{ "id", "name", "installed", "version?", "detail?", "error?",
    "action?": { "label", "running" } }`;
  - `POST /deps/<id>/action` → `202 {"running":true}` (409 while busy). The
    listener performs the action itself — Craft never executes listener
    strings; a missing `action` renders no button; `running: true` disables
    it while Craft polls `/deps` every 2 s.

  No `control.json` within 5 s of start simply renders "no dependency info"
  — the service is optional and never blocks startup.

`dependencies.runtime` is **deprecated** (Craft no longer probes a hardcoded
interpreter table): verify your runtime in the listener itself and report via
the control service, or declare `packages`/`mcp` instead.

### Startup failure display

When the process gives up with a non-zero exit, Craft snapshots the last
30 lines of `proc.log` and shows them in a collapsible block under the
description on the detail page.

### Environment handed to your program

| Variable | Meaning |
|---|---|
| `CRAFT_EVENTS_URL` | `http://127.0.0.1:<port>/events/<yourId>` |
| `CRAFT_EVENTS_TOKEN` | bearer token, regenerated every start |
| `CRAFT_LISTENER_ID` | your id |
| `CRAFT_LISTENER_DATA` | writable data dir |
| `CRAFT_LISTENER_CONFIG` | path to `<dataDir>/config.json` holding the user's saved config (email, authCode…), mode 600 — only set when config is non-empty |

The same address and token are published to
`<workspace>/config/events.json` (mode 600) so you can curl by hand while
developing.

### Posting an event

```bash
curl -X POST "$CRAFT_EVENTS_URL" \
  -H "Authorization: Bearer $CRAFT_EVENTS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "type": "mail.received",
        "title": "张三 · 合同确认",
        "summary": "请确认付款条款",
        "dedupeKey": "imap:INBOX:8842",
        "recipients": ["me@qq.com"],
        "body": "正文…"
      }'
```

`id`, `source` and `receivedAt` are assigned by Craft — sending them is
ignored, so one listener cannot forge another's events.

| Response | When |
|---|---|
| 200 `{id, duplicate}` | accepted (or already seen via `dedupeKey`) |
| 400 | validation failed; the body names the field. Non-UTF-8 bytes are also rejected here (`invalid_encoding`) instead of being stored as mojibake |
| 401 | bad/missing token |
| 403 | `Host` was not loopback (DNS rebinding) |
| 413 | body > 256KB — use `payloadRef` for large payloads |
| 415 | not `application/json` |
| 503 | store busy; honour `Retry-After` and retry |

### Health

`GET $CRAFT_EVENTS_URL/health` returns `{ok:true}` — it is served by Craft, and
your listener can call it to prove it started and can reach the endpoint (the
token works there too). The first successful health call flips the card from
"starting" to running; answer nothing within `readyTimeoutMs` (no health call,
no event) and the card shows "started but not responding" instead. Craft does
**not** restart you for that — slow imports are legitimate.

## Subscribing from a session

Sessions start with **no** subscriptions.

```
subscribe_event({ types: ["mail.*"] })
list_events({ source: "qqmail-idle", limit: 20 })
get_event({ id: "evt_..." })
unsubscribe_event({ subscriptionId: "sub_ab12cd34" })
```

Delivered events arrive as `[event]` messages and wake the session. Three
guards keep a busy mailbox from flooding a conversation:

- events from one source are merged inside a 5s window,
- 50 deliveries per session per day, then a single summary,
- while a session is mid-turn (or has queued user messages) events queue and
  are released when the turn ends — they never steer into a running turn.

## Storage

`<workspace>/config/events.sqlite`, one table plus an FTS5 index.

Search is bigram-ised for CJK: `unicode61` cannot split Chinese (no spaces) and
`trigram` cannot match the 2-character queries people actually type. The
searchable text is `title + summary + first 4KB of body`; the rest is stored
but not indexed.

List queries never select the body — only `get_event` / `events:get` reads it.

Rows are pruned when the event service starts (per app launch / workspace
switch): 90 days of age, at most 50 000 rows. Between restarts nothing is
deleted — long uptimes can exceed the caps until the next start.
