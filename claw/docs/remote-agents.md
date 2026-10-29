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
user's sessions. A connector acts for the user that owns it, and authenticates with
either of two kinds of credential: the ones the whole API accepts (a key or a
session), or an access token from the identity provider (see
[Connector access tokens](#connector-access-tokens)).

## Connector side

| Route | Purpose |
|---|---|
| `POST /v1/remote-agents/connectors` | Register `{name, version?}`; returns `connector_id`. At most 5 per user. |
| `POST .../connectors/:cid/heartbeat` | Every 30 s: `{version?, agents:[{agent_id, kind, name, capabilities?}], cmd_cursor?}`. Replaces the advertised agent list; `cmd_cursor` lets the server forget commands up to it. |
| `GET .../connectors/:cid/commands` | The command stream; each `id:` is the connector's `cmd_seq`. On every connect the server sends every command it still holds, in order. It holds a command until a heartbeat's `cmd_cursor` covers it, so a `Last-Event-ID` (or `?after=`) is validated but never skips one: the id of the last frame a client received does not prove it acted on it. A connector skips what it already did, by `cmd_seq` or `cmd_id`. |
| `POST .../connectors/:cid/events` | `{batch_id, events:[{session_id, seq, type, ts, data}]}`. Answers `{acked:{session_id: highest stored seq}, rejected:[{index, session_id, seq, reason}]}`. |

Command frames are `event: command` with `data: {v, cmd_id, type, session_id, ...}`.
Delivery is at least once: a connector deduplicates on `cmd_id` (or skips `cmd_seq` values it has handled). Types: `session.new`
(`agent_id`, `cwd`, `mode`, and `resume_ref` when the user chose an existing session), `prompt` (`text`), `cancel`, `set_mode` (`mode_id`),
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

### Continuing a session that already exists

A connector may offer sessions that already exist on its machine instead of (or beside) starting new ones. Claw does not
model that: the agent's `capabilities` (at most 4 KB, replaced by every heartbeat) may carry `resumable`, a list that only the
connector and the user's client understand, and a client that wants one of them sends `POST /v1/remote-agents/sessions` with
`resume_ref`, an opaque string of 1 to 128 printable characters that Claw forwards unread in the `session.new` command and
records in the audit trail. The connector decides what it means and refuses what it cannot honour (the session is then
closed with a `reason`); an agent that does not offer existing sessions closes the session with `resume_not_supported` rather
than start a new conversation.

The convention the connector in this repository uses for `resumable`, newest first and at most twelve entries:
`[{ref, title, cwd, updated_at, state}]` with `ref` the value to send back as `resume_ref`, `updated_at` in seconds since the
epoch, and `state` one of `idle`, `live` (something else has it open: not offered for takeover), `attached` (this
connector already holds it) or `unknown`.

## Connector access tokens

Beside a key or a session, the four connector-side routes (the table above)
accept `Authorization: Bearer <access token>`: an RFC 9068 JWT that the identity
provider issued to this API for a connector. It is verified with the shared
[identity client](identity-client.md), which must be on (`IDENTITY_CLIENT_ENABLED`),
and it is on only while `CLAW_REMOTE_AGENTS_ENABLED` is. With either off, a token is
just an unknown credential and nothing changes.

A token is accepted only if all of these hold, and is refused for exactly the one
that does not (`401 invalid_token`, naming the reason, or `403 insufficient_scope`):

| Check | |
|---|---|
| Signature | RS256 or ES256, by a key the issuer currently publishes |
| `iss` | the configured issuer |
| `aud` | `claw-api` (`CLAW_CONNECTOR_TOKEN_AUDIENCE`) |
| `typ` | `at+jwt` |
| `exp`, `nbf` | the token is current |
| `scope` | contains `claw.connector` |
| `sub` | a non-empty subject, which becomes the owner |

The caller is the token's `sub` with the `default` role only, whatever roles or
groups the token carries.

**`sub` must be the same user id the user's own clients resolve to.** Every
remote-agents row is owned by the caller's id. A person's own clients (a session cookie,
an `ak-` key, a BYOK key) are owned by the id Claw's own authentication produces for
them, so an identity provider has to issue the connector's token with that id as `sub`.
If it issues some other subject (an opaque UUID where Claw has a user name, say), the
connector registers and shows online, but that person's `GET /v1/remote-agents/connectors`
is empty and `POST /v1/remote-agents/sessions` with its id is `404 not_found`, with no
error naming the cause. Claw has no second source for the user's id, so it cannot detect
the mismatch itself; it logs the id every connector is filed under at registration
(`remote_agents.connector_registered`, with `owner` and `credential`), for an operator to
compare with the id of the person's own session.

**It authenticates on those four routes and nowhere else.** On the user-side
routes, and on every other route of the API, a token is not a credential: the
request is answered as one with no credential (with the identity provider's
access-token credential switched on, `CLAW_IDENTITY_TOKEN_AUTH_ENABLED`, it is
judged by that path instead and refused for its scope, `403 insufficient_scope`;
see [identity-client.md](identity-client.md#access-tokens-as-an-api-credential)). The user side of this module also
refuses a connector token itself (`403 connector_token_not_accepted`), so a change
to what the global hook accepts cannot let a connector read a session or issue a
command.

**Revocation.** A token is checked locally, so a revoked grant is honoured until its
token expires (minutes). Set `CLAW_CONNECTOR_TOKEN_INTROSPECT=true` to also ask the
provider, on each request, whether the token is still active (the identity client
caches an answer for a few seconds, `IDENTITY_INTROSPECTION_CACHE_SECONDS`); a revoked
grant is then refused at once. A provider that cannot be asked is `503`, never a yes.

**An open command stream** is authenticated once, when it opens, so it also ends with
its token: at the token's `exp` the server sends `event: token_expired` (no `id`) and
closes, and the connector reconnects with a fresh token. With introspection on, the
stream is re-checked about as often as a ping, and a grant revoked in the meantime
ends it with `event: revoked`, as a revoked connector does. A provider that cannot be
asked does not cut a stream that was already authenticated; the token's expiry still
bounds it. A stream opened with a key or a session has no such end.

| Variable | Default | Meaning |
|---|---|---|
| `CLAW_CONNECTOR_TOKEN_AUDIENCE` | `claw-api` | The `aud` a token must name |
| `CLAW_CONNECTOR_TOKEN_INTROSPECT` | off | Ask the provider on each request whether the token is still active |

The audit trail records, in `detail.credential`, how the caller was authenticated
for the connector-side actions it keeps (`connector.registered`,
`permission.requested`, `permission.resolved`): `connector_token`, `api_key`,
`cookie` or `x_api_key`.

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
| `POST /v1/remote-agents/sessions` | `{connector_id, agent_id, cwd, mode?, resume_ref?}`. `409 connector_offline` unless online. |
| `GET .../sessions`, `GET .../sessions/:id` | List, and read one with `connector_online`. |
| `POST .../sessions/:id/commands` | `{type: prompt\|cancel\|set_mode\|resume\|close, ...}`. `Idempotency-Key` makes a retry queue one command. |
| `POST .../sessions/:id/decisions` | `{action_id, option_id}`, an option the agent offered. Answered twice, counted once: a different second choice is `409 already_decided`, even after the connector has acknowledged the first, because the audit trail remembers it. |
| `GET .../sessions/:id/events` | History, a `historyComplete` marker, then live events, in the frame format of `/v1/chat/sessions/:id/messages`; resume with `Last-Event-ID` or `?after=`; when both are sent `Last-Event-ID` wins, because a browser reconnecting to the same URL changes only that header. `?mode=replay` returns JSON pages. |
| `GET /v1/remote-agents/audit` | The caller's audit trail, filterable by `session_id` and `connector_id`. |

`prompt`, `set_mode` and `resume` are refused with `409 connector_offline` while the
connector is offline, so a prompt nobody could see being waited on cannot run later.
`cancel`, `close` and `decision` are queued, since they are safe to deliver late.

The same rule holds after a command is accepted. A connector counts as online for up to
90 s after its connection has died unnoticed (a closed laptop), so a `prompt`, `set_mode` or
`resume` accepted then goes into a dead socket. Such a command is delivered for 5 minutes
(`REMOTE_AGENT_TIMING.liveCommandTtlMs`) and then dropped: a connector that comes back
later is not sent it, and the queue row is deleted. A client that gets no events for a prompt
sends it again. `cancel`, `close` and `decision` stay deliverable for a day.

`Idempotency-Key` holds for as long as the audit trail does, not only while the command is
queued: a retry made after the connector has acknowledged the command is answered
`200 {duplicate: true}` and queues nothing, and the same key with another command type or
another session is `409 idempotency_key_reused`.

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
unacknowledged (5 minutes for `prompt`, `set_mode` and `resume`): an instruction nobody has
collected for that long should not run.
