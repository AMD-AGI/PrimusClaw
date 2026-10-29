<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Remote agents

A remote agent is a program that runs on a user's own machine and dials out to
Claw. A small client there (a connector) tells Claw which agents it can run,
receives commands over one long-lived `text/event-stream`, and posts the events
those agents produce back in batches. Claw relays, stores and audits them. It
does not interpret an agent's output and knows no agent product by name: an
agent's `kind` is a label the connector chooses, and an event's `data` is
whatever the agent said. The user's own clients (a chat bot, a web page) read a
session and send commands through the same API.

The machine opens no inbound port. Everything is an outbound HTTPS request.

Off by default. Set `CLAW_REMOTE_AGENTS_ENABLED=true` on the API (through the
chart's `api.extraEnv`) to create the tables and register the routes. With it
unset the paths do not exist.

The wire contract, limits and parsers are in `packages/protocol/src/remote-agents.ts`.

## Access

Every row belongs to one user, taken from the verified caller. Every read and
write is filtered by it, so another user's id answers `404 not_found`, exactly as
a missing id does. Administrators are ordinary callers here; they cannot read a
user's sessions. A connector authenticates with the same credential as any other
API call, and acts for the user that owns it.

## Connector side

| Route | Purpose |
|---|---|
| `POST /v1/remote-agents/connectors` | Register `{name, version?}`; returns `connector_id`. At most 5 per user. |
| `POST .../connectors/:cid/heartbeat` | Every 30 s: `{version?, agents:[{agent_id, kind, name, capabilities?}], cmd_cursor?}`. Replaces the advertised agent list; `cmd_cursor` lets the server forget commands up to it. |
| `GET .../connectors/:cid/commands` | The command stream; each `id:` is the connector's `cmd_seq`. On every connect the server sends every command it still holds, in order. It holds a command until a heartbeat's `cmd_cursor` covers it, so a `Last-Event-ID` (or `?after=`) is validated but never skips one: the id of the last frame a client received does not prove it acted on it. A connector skips what it already did, by `cmd_seq` or `cmd_id`. |
| `POST .../connectors/:cid/events` | `{batch_id, events:[{session_id, seq, type, ts, data}]}`. Answers `{acked:{session_id: highest stored seq}, rejected:[{index, session_id, seq, reason}]}`. |

Command frames are `event: command` with `data: {v, cmd_id, type, session_id, ...}`.
Delivery is at least once: a connector deduplicates on `cmd_id` (or skips `cmd_seq` values it has handled). Types: `session.new`
(`agent_id`, `cwd`, `mode`), `prompt` (`text`), `cancel`, `set_mode` (`mode_id`),
`resume`, `close`, `decision` (`action_id`, `option_id`, `by`). Nothing else is ever sent.

Events are stored once per `(session_id, seq)`; a repeat is ignored and a gap is
allowed. A malformed event is refused alone and named in `rejected`, so one bad
event cannot block the good ones behind it; retrying a rejected event cannot help.
One event's `data` is at most 64 KB, and a request body at most the API's 4 MiB
limit. Credentials in `data` are masked before storage.

Special event types: `permissionRequest` (`data.actionId`, `data.options[].optionId`),
`permission_resolved` (`data.actionId`, `data.optionId`, `data.by`), and
`session_closed`. They are audited, and `permissionRequest` is what a decision is
checked against.

## Keepalive and presence

The server sends `event: ping` every 25 s on the command stream (it carries no `id`,
so it is never a resume position) and a `: keepalive` comment on a reading stream.
A gateway that closes a connection after 180 s of silence therefore never sees one.
A connector that receives no byte for 75 s should drop the stream and reconnect
with backoff.

A connector is **online** while its command stream is open and its last heartbeat is
at most 90 s old; a closed stream is offline at once. A newer stream for the same
connector replaces the older, which receives `event: superseded` and ends. When a
connector is revoked its stream receives `event: revoked` and ends, and every
connector-side route answers `401 revoked`.

## User side

| Route | Purpose |
|---|---|
| `GET /v1/remote-agents/connectors` | The caller's connectors, with `online` and their agents. |
| `DELETE .../connectors/:cid` | Revoke: closes its sessions, drops its queued commands. |
| `POST /v1/remote-agents/sessions` | `{connector_id, agent_id, cwd, mode?}`. `409 connector_offline` unless online. |
| `GET .../sessions`, `GET .../sessions/:id` | List, and read one with `connector_online`. |
| `POST .../sessions/:id/commands` | `{type: prompt\|cancel\|set_mode\|resume\|close, ...}`. `Idempotency-Key` makes a retry queue one command. |
| `POST .../sessions/:id/decisions` | `{action_id, option_id}`, an option the agent offered. Answered twice, counted once: a different second choice is `409 already_decided`, even after the connector has acknowledged the first, because the audit trail remembers it. |
| `GET .../sessions/:id/events` | History, a `historyComplete` marker, then live events, in the frame format of `/v1/chat/sessions/:id/messages`; resume with `Last-Event-ID` or `?after=`; when both are sent `Last-Event-ID` wins, because a browser reconnecting to the same URL changes only that header. `?mode=replay` returns JSON pages. |
| `GET /v1/remote-agents/audit` | The caller's audit trail, filterable by `session_id` and `connector_id`. |

`prompt`, `set_mode` and `resume` are refused with `409 connector_offline` while the
connector is offline, so a prompt nobody could see being waited on cannot run later.
`cancel`, `close` and `decision` are queued, since they are safe to deliver late.

Limits per user: 5 connectors, 10 active sessions, 60 commands a minute, 20 open
event streams per API replica.

A write made through the same API replica reaches an open stream at once. A write
made through another replica is found by the stream's own read of the database,
which an idle stream does every 5 s, so it can arrive up to that much later.

## Retention

A closed session is deleted with all of its events `CLAW_REMOTE_AGENTS_RETENTION_DAYS`
days (default 30) after it closed; each API replica checks hourly. Zero or less keeps
them for ever. Live sessions are never deleted, and neither is the audit trail.

## Audit

`claw_remote_audit` records who did what through which client (`X-Claw-Client`, a short
label): connector registered and revoked, session created, every command issued, every
permission requested and resolved. A prompt is recorded as its SHA-256 and length,
never its text. A queued command is deleted once a heartbeat acknowledges it, or after a day
unacknowledged: an instruction nobody has collected for that long should not run.
