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
| `POST .../connectors/:cid/revoke` | Revoke one of the caller's connectors, as the user-side `DELETE /v1/remote-agents/connectors/:cid` does (the row stays revoked, its commands go, its sessions close): what `claw-connector logout` calls with a device sign-in, whose access token the user-side route refuses. The token names a user, not a connector, so it may revoke any of that user's connectors. `404 not_found` for a row that is not the caller's or is already revoked. |

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

The connector in this repository names the prompt a turn ends: `turn_end` carries `data.cmd_seq` and
`data.cmd_id`, the `cmd_seq` (the frame's `id:`) and `cmd_id` of the `prompt` command that started the turn, both
`null` for the end a `cancel` posts when no turn was running. A prompt that never runs gets no `turn_end`; it is
refused by name instead, as `command_rejected` (`data.type: "prompt"`, `data.cmd_id`, `data.cmd_seq`,
`data.reason`), and the prompts a `cancel` drops from the queue are refused this way with `reason: "cancelled"`.
Claw matches on `cmd_seq`: a `cmd_id` may be a client's `Idempotency-Key`, which the credential masking of
events can change, and a number it never does. A connector from before this change sends neither in `turn_end`,
and its dropped prompts are not refused.

After a restart the connector ends a turn its previous run left running with `turn_end`
`{"stopReason": "error", "error": "connector_restarted"}` (naming its prompt), or carries it on under the same prompt
when the agent was waiting for a permission (it asks again; that prompt's own `turn_end` ends it). Each session used
lately then gets one `session_recovered` (`data.interrupted`, `data.continuing`, and `data.cmd_id`/`data.cmd_seq` of the
turn when there was one). Claw stores and relays it like any other event.

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
epoch, and `state` one of `idle`, `live` (something else has it open: not offered for takeover; a session for it is opened
read-only, see below), `attached` (this connector already holds it) or `unknown`; a `live` entry may add `activity`
(`working`, `waiting` for the person at that terminal, or `idle`) and, with `waiting`, `waiting_for` (a short phrase in the
agent's words). `devenv_list` shows `activity` as `terminal_state` and `waiting_for` only with `detail: "activity"`.

An agent whose connector can do that says `watch_live: true` in its capabilities. A session the connector opens to
watch a conversation that a terminal on that machine has open is read-only: its
`session_started` (and `session_resumed`) carries `read_only: true`, and so does every event it sends. The API reads that
mark from the session's newest `session_started`/`session_resumed`: `GET .../sessions` and `GET .../sessions/:id` answer
`read_only`, every frame of its event stream (and of `?mode=replay`) carries `read_only: true` next to `data`, and
`prompt`, `set_mode` and `decision` are refused with 409 `session_read_only` before anything is queued (`cancel`, `resume`
and `close` are not). The connector refuses them as well (`read_only_live_session`).

`POST /v1/remote-agents/sessions` also takes `takeover: true` next to a `resume_ref` (400 `takeover_needs_resume_ref` without
one, 400 `invalid_takeover` when it is not a boolean): the person confirmed that whatever holds that conversation open on the
machine is to be ended so that this session continues it. Claw forwards it in `session.new` and records it in the
`session.created` audit row; it does not interpret it. Because it ends a process, it is a live command: the `session.new` carries `takeover_until` (now + the live-command TTL) and is dropped, like a `prompt`, when nobody collects it within that TTL; the connector refuses one past its deadline (`takeover_expired`). A connector that can do this says `takeover: true` in the agent's
capabilities; one that cannot ignores the field, and the session is watched read-only as above.

## Whether a session asks before it acts

Whether an agent asks the user before it writes a file or runs a command is the machine owner's choice,
made in the connector's own configuration; nothing Claw sends can change it. Claw does not interpret what the
connector reports about it, and relays it unchanged (an agent's `capabilities`, and an event's `data`, are opaque to
the API). The connector in this repository reports these keys, none of which names a product:

| Where | Key | Meaning |
|---|---|---|
| an agent's `capabilities` | `unattended` | Its sessions start in a mode that does not ask before a write or a command. |
| an agent's `capabilities` | `unattended_allowed` | A client may switch this agent to such a mode (`set_mode`). Where it is `false` the connector refuses the switch (`command_rejected`, `mode_not_allowed`). |
| `session_started`, `session_resumed`, `mode_update` event `data` | `unattended` | This session, as it is now, does not ask. It is also `true` when the agent has said it will not ask, whatever its mode is called. |
| `data.modes[]` of `session_started` and `session_resumed` | `unattended` | Selecting this mode makes the session unattended. |

A client should show `unattended` wherever it shows a session's mode, so nobody is surprised that nothing asks. The keys are
absent from a connector that predates them: a client treats absent as unknown, not as "asks".

**Health.** In connectors newer than 0.1.5 every agent's `capabilities` also carries `health`: `{checked_at, problems: [{code, severity, scope,
detail, fix}]}`, what the connector's own checks (`claw-connector doctor`) found with the environment its agents get, re-checked
every 15 minutes and when `doctor` signals the connector. `scope` is `agent` (about this agent) or `machine` (repeated in every agent of the
connector; a client shows it once per machine). `severity` is `fail` (sessions will not work until it is fixed) or `warn`.
`detail` and `fix` are English lines for a client that does not know the `code`; `fix` is a command or edit for the machine.
The codes: `node_too_old`, `agent_cli_missing`, `agent_not_signed_in`, `root_missing`, `root_not_writable`, `proxy_mismatch`,
`proxy_invalid`, `no_service`, `linger_off`, `keepalive_not_scheduled` (and from `doctor` alone: `claw_unreachable`, `claw_tls_untrusted`, `service_path_missing`, `config_invalid`, `not_signed_in`, `needs_login`). An empty `problems` means the checks passed; an absent
`health` means unknown (an older connector, or the first check not done yet). `devenv_list` relays the problems to the assistant.

## Connector access tokens

Beside a key or a session, the five connector-side routes (the table above)
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

**It authenticates on those five routes and nowhere else.** On the user-side
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
provider, on each request, whether the token is still active; a revoked grant is then
refused within `CLAW_CONNECTOR_TOKEN_INTROSPECT_MAX_AGE_SECONDS` (5 by default) on every
replica. The identity client keeps an answer for `IDENTITY_INTROSPECTION_CACHE_SECONDS`
(30) for every caller; a connector token is judged by none older than this. A provider
that cannot be asked is `503`, never a yes, unless the client still holds an active
answer for the token inside its stale window (`IDENTITY_STALE_IF_ERROR_SECONDS`).

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
| `CLAW_CONNECTOR_TOKEN_INTROSPECT_MAX_AGE_SECONDS` | `5` | The oldest provider answer a connector token is judged by (0: ask every time; 0..300) |

The audit trail records, in `detail.credential`, how the caller was authenticated
for the connector-side actions it keeps (`connector.registered`,
`permission.requested`, `permission.resolved`): `connector_token`, `api_key`,
`cookie` or `x_api_key`.

## Pairing a machine with a one-time code

The first connection of a machine needs no sign-in on it. The person asks their own client (Clawy: "连接我的开发环境", or the
router's `devenv_pair` tool, or `devenv_list` itself when the person has no machine yet: its `connect_a_machine` is then this
pairing command, made in a turn answering their own message); the client calls `POST /v1/remote-agents/pairings` as that person and shows the answer's `command`:

```
npm install -g @primusclaw/connector@latest && claw-connector pair ABCD-EFGH-JKMN --server https://claw.example.com/claw-api
```

Running it on the machine is the approval. `claw-connector pair` posts `{code, name}` to `POST /v1/remote-agents/pairings/claim`,
which is anonymous (the code is the credential), writes `agents.toml` if there is none (the agents found on the machine, working in
the folder the command was run in), saves the answer's grant (mode 0600) and starts the connector as a service.

- **Code**: 12 characters of Crockford base32 (60 bits), shown as `XXXX-XXXX-XXXX`; case, dashes and O/I/L-for-0/1 do not matter.
  Good for 10 minutes and one claim; a person has at most 3 live, and a new one retires the oldest. Only its SHA-256 is stored
  (`claw_remote_pairings`). A wrong, expired, retired and used code all get the same `400 invalid_code`. At most 6 codes a minute
  per person, by any route (the HTTP route and the assistant's `devenv_pair`; counted from the audit trail). Wrong claims are
  throttled per caller: the whole `X-Forwarded-For` chain as received together with the socket address (behind the ingress the
  socket address alone is the ingress's, shared by everyone, and the first entry alone is the caller's say; the chain ends with the
  address the proxy saw). 10 a minute, only failures count, so nobody's wrong codes lock out a right one. What
  a flood of made-up keys can spend is bounded apart from the keys: at most 10,000 callers are remembered (oldest first out), and at
  most 4 claims reach the database at once with 64 waiting; beyond that `503 busy`, which passes with the flood. Without `CLAW_PUBLIC_URL` there is no command to give: `503 pairing_unavailable`.
- **Grant**: `cpg_` and 43 base64url characters, stored as its SHA-256 (`claw_remote_grants`). The global auth hook judges a
  `Bearer cpg_...` before every other credential path, so it never reaches SaFE or the identity provider. It authenticates as the
  person, with the `default` role, on the connector-side routes and nowhere else (anything else: `403 connector_grant_not_accepted`).
  Before it has registered, it reaches no existing connector (only registration). Its registration binds it to that connector, in
  the registration's own transaction: from then on another connector id is `403 connector_grant_mismatch`, and once that connector
  is revoked (`/agent off`, `claw-connector logout`, `DELETE /v1/remote-agents/connectors/:cid`), or its row is gone, every request
  is `401 revoked`, which stops the connector for good.
- **What a grant's registration replaces**: only its own row. Unlike a key or a device sign-in, a grant never revokes another row
  of the owner's that has the same name (#395's replacement of a stale same-name row does not apply to it). Bound already, it may
  register again (lost local state) only under its own row's name, and that row is replaced; another name is
  `403 connector_grant_name_mismatch`, so the name the owner was told to `/agent off` is always the grant's. A grant that never
  registered is refused an hour after its claim and then deleted.
- **Telling the owner**: the first registration under a grant tells the owner once, through their assistant, that the machine is
  paired and how to disconnect it if they did not run the command themselves.
- **Audit**: `pairing.created`, `pairing.claimed` (with the grant id and the name the machine gave), and the registration's
  `connector.registered` with `credential: connector_grant`.

## Keepalive and presence

The server sends `event: ping` every 25 s on the command stream (it carries no `id`,
so it is never a resume position) and a `: keepalive` comment on a reading stream.
A gateway that closes a connection after 180 s of silence therefore never sees one.
A connector that receives no byte for 75 s should drop the stream and reconnect
with backoff.

**A Claw release.** An API replica that receives SIGTERM sends `event: reconnect`
(`data: {"connector_id": ...}`, no `id`) on every command stream it holds, then ends
them. A connector reconnects at once on that frame, without its backoff and without
waiting for the response to end. The server keeps such a connector online while it
does (the stream ended with `stream_end_reason` `restart` still counts as seen), so a
rolling update records no offline transition; one that does not reconnect is offline
once the online window below has passed.

A connector is **online** while its command stream is open and its last heartbeat is
at most 90 s old; a closed stream is offline at once (except after `event: reconnect`,
above). A newer stream for the same
connector replaces the older, which receives `event: superseded` and ends. When a
connector is revoked its stream receives `event: revoked` and ends, and every
connector-side route answers `401 revoked`.

**Presence over time.** Every 15 s one API replica (an advisory lock picks it) compares
each connector with the presence it last recorded and writes every change it sees to
`claw_remote_connector_transitions`. `GET /v1/remote-agents/connectors` gives each
connector `last_seen_at` (its last heartbeat or stream activity) and, while offline,
`offline_since` (when it was last seen before it went) and `offline_reason`:
`auth_expired` when the server ended its last stream because its token expired or its
grant was revoked, `no_heartbeat` otherwise.

When the assistant is on, a connector that stays offline for 5 minutes, counted from when
the sweep first found it offline, is reported once to its owner through their assistant:
when it was last seen, why it went, and the command that brings it back
(`claw-connector run`, after `claw-connector login` when its sign-in ran out). When it
comes back after that, the owner is told once that it has. Short breaks (a Claw release
cuts every stream for a few seconds) and a Claw outage (the sweep is down with it) are
never reported. Nothing is said about a connector its owner revoked, one replaced by an
online connector of the same name, or one that was already offline when presence was
first recorded for it. Transitions are kept as long as closed sessions are (Retention).

**A terminal that waits for its person.** A connector reports what each conversation a terminal
holds open is doing there (`capabilities.resumable`, `state: "live"`, `activity`: `working`,
`waiting`, `idle`, and with `waiting` its `waiting_for`). On the same 15 s sweep, a conversation
that has been `waiting` for a minute, counted from when the sweep first saw it wait, on a machine
that is online, is said once to its owner through their assistant: the machine, the agent, what it
waits for and the conversation's title. Someone at that terminal answers within the minute and is
never told; working and finishing in a terminal are never pushed (the person there sees them). The
episode ends when the conversation stops waiting or its machine goes offline, and a later wait is
told again once (`claw_remote_terminal_waits`).

## User side

| Route | Purpose |
|---|---|
| `GET /v1/remote-agents/setup` | How to connect a machine to this server: the npm package, the exact commands with this deployment's addresses, the minimum and recommended connector versions, and the same as a short text in English and Chinese (`remote-agents/setup.ts`). |
| `GET /v1/remote-agents/connectors` | The caller's connectors, with `online`, `last_seen_at`, `offline_since`, `offline_reason`, `version_status` (and `upgrade_command` below the recommended version) and their agents. |
| `DELETE .../connectors/:cid` | Revoke: drops its queued commands and closes its sessions, each with a `session_closed {reason: "connector_revoked", by: "claw"}` of Claw's own (`"machine_reconnected"` when a row is replaced by registering again under its name), so whatever waited on them ends. |
| `POST /v1/remote-agents/sessions` | `{connector_id, agent_id, cwd, mode?, resume_ref?}`. `409 connector_offline` unless online; `409 connector_outdated` (with `data.version`, `data.upgrade_command`) when its connector is below the minimum version. |
| `GET .../sessions`, `GET .../sessions/:id` | List (each active session with `waiting`: the permission requests it waits on its user for now, asked since its last turn ended and not answered, so a client lists those first), and read one with `connector_online`. |
| `POST .../sessions/:id/commands` | `{type: prompt\|cancel\|set_mode\|resume\|close, ...}`. `Idempotency-Key` makes a retry queue one command. |
| `POST .../sessions/:id/decisions` | `{action_id, option_id}`, an option the agent offered. Answered twice, counted once: a different second choice is `409 already_decided`, even after the connector has acknowledged the first, because the audit trail remembers it. |
| `GET .../sessions/:id/events` | History, a `historyComplete` marker, then live events, in the frame format of `/v1/chat/sessions/:id/messages`; resume with `Last-Event-ID` or `?after=`; when both are sent `Last-Event-ID` wins, because a browser reconnecting to the same URL changes only that header. `?mode=replay` returns JSON pages. |
| `GET /v1/remote-agents/audit` | The caller's audit trail, filterable by `session_id` and `connector_id`. |

A new session, `prompt`, `set_mode` and `resume` are refused with `409 connector_offline` while
the connector is offline, so a prompt nobody could see being waited on cannot run later.
`cancel`, `close` and `decision` are queued, since they are safe to deliver late. A connector
whose command stream has just ended still counts as online for 45 s (`STREAM_GRACE_SECS`)
while its heartbeat is fresh: a Claw release, an ingress restart or a token refresh ends every
stream and the connector opens the next within seconds, so what is asked in that gap is queued
and delivered on the new stream, not refused.

The same rule holds after a command is accepted. A connector counts as online for up to
90 s after its connection has died unnoticed (a closed laptop), so a `session.new`, `prompt`,
`set_mode` or `resume` accepted then goes into a dead socket. Such a command is delivered for
5 minutes (`REMOTE_AGENT_TIMING.liveCommandTtlMs`) and then dropped: a connector that comes
back later is not sent it. One minute later (the slack for an acknowledgement on its way), when
its machine went away after it was queued (offline now, or recorded offline since), its session has
heard nothing from the machine since, and no turn was running when it was queued, Claw deletes the
queue row, on the connector's next heartbeat (judged before that beat is recorded) or on a sweep
every 15 s whether or not the machine comes back. A prompt's turn is then ended with an event of
Claw's own (`data.by = "claw"`, a negative `seq`): `turn_end {stopReason: "error", error:
"delivery_unconfirmed", cmd_seq}`. Claw cannot tell whether the machine took the prompt just before
it went (a connector acknowledges a prompt only when it reaches the agent, and says so on its next
heartbeat), so it never says the prompt did not run: a chat attached to the session and the
assistant's item end on it with "may not have run" instead of waiting hours for a turn's end, and
an end of the machine's own for that prompt, if it comes once the machine is back, still closes the
item with its answer. A `session.new` gets no event and its session is left open (the machine may be
starting it); a `set_mode` or `resume` is dropped. `cancel`, `close` and `decision` stay deliverable for a day.

`Idempotency-Key` holds for as long as the audit trail does, not only while the command is
queued: a retry made after the connector has acknowledged the command is answered
`200 {duplicate: true}` and queues nothing, and the same key with another command type or
another session is `409 idempotency_key_reused`.

Limits per user: 5 connectors, 10 active sessions, 60 commands a minute, 20 open
event streams per API replica.

### Connector versions and setup

The connector reports its version when it registers and in every heartbeat. A server takes
connectors from a minimum version and recommends one (`CONNECTOR_VERSIONS` in the protocol,
0.1.3 and 0.1.4; `CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION` and
`CLAW_REMOTE_AGENTS_RECOMMENDED_CONNECTOR_VERSION` move them, a value that is no `x.y.z` is
ignored). Each connector is `current`, `outdated` (below the recommended version: it works),
`unsupported` (below the minimum: it registers and is listed, so its owner sees why, but no
new session starts on it) or `unknown` (it reports no version: not refused). Below the
recommended version the connector list, `devenv_list` and the heartbeat's answer
(`connector_version`) carry the command that upgrades it and restarts it on the new version:
`npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install`
(`stop` exits 0 when nothing runs, so a failed install stops the chain). Sessions already open
are not touched.

What a person runs to connect a machine is given by the server, never written by a client
or a model: `GET /v1/remote-agents/setup`, and `connect_a_machine` in `devenv_list` (no
machine, where no pairing can be made for the turn) and in a `devenv_send` refused `no_machine`. Its `login` line names this server's
`CLAW_PUBLIC_URL` and the identity service the connector signs in with
(`CLAW_CONNECTOR_IDENTITY_URL`, else `IDENTITY_ISSUER_URL`). Sessions are not closed on their own: a new one at the
session limit closes the user's sessions nobody is using to make room (no event for half an
hour, no command waiting for its connector, no turn under way and no approval waiting; or no
event for a day; or a read-only session, which only watches a terminal's conversation, whatever
that terminal writes), a machine that is offline first, then read-only sessions, each with a
`close` to its connector and a `session.reclaimed` audit, and `201` names them in `reclaimed`. Only when none may be closed is
the answer `409 session_limit_reached`.

A write made through the same API replica reaches an open stream at once. A write
made through another replica is found by the stream's own read of the database,
which an idle stream does every 5 s, so it can arrive up to that much later.

## The assistant

Where remote agents are on, the assistant's router has a read-only tool, `devenv_list`, and
its prompt treats the user's development environments (开发环境, dev box, my machine) as their
connectors, never as SaFE workspaces. The tool answers the caller's own connectors that are not
revoked: each machine's name, whether it is online, when it was last seen, its version and its
agents; and every session on it, both the ones open through Claw and the agents' own
conversations a connector offers to take over (`capabilities.resumable`), each with its folder,
state (`working`, `waiting_for_you`, `idle`, `in_terminal`), last activity, a label
(`machine/agent/n`) and the command that attaches the user's chat to it
(`/agent attach <session id or conversation ref>`). The router passes that command to the
channel with `channel_action`; a machine that is offline has none. A conversation open in a
terminal on the machine has one too when its agent reports `watch_live`, marked `read_only` with a
`note`: attaching to it only watches it, and it is never the `attach_default` (from an older
connector it has none). A session open through Claw that watches one is `read_only` too, with
state `in_terminal`: it is never at work for Claw, whatever the terminal does. `detail: "activity"` adds each session's current step and the end of
its last answer. Names, folders and what agents wrote can be named by anyone, so a turn that has
read the list no longer acts for the user, with one exception: it may still put
`/agent attach <ref>` for one of the user's own attachable sessions to them, as a button they
press (never run at once); any other ref or action is refused. Each agent on an online machine
carries such a command too, `/agent attach <machine>/<agent>`, which the channel takes as "that
agent's newest open session, else a new one in its first folder": how a user with no session
gets one. An agent that only takes over existing conversations (`kind: attach`), one that
reports no folder, or one on a machine whose name another online machine of the user's shares
has none. With no session anywhere and one such agent, it is `attach_default`
(`new_session: true`).

### Development environment items

Work on the user's machines is on their work item list (`kind = 'remote'`, one item per session, filed
under the worker session id `remote:<session id>`), so the assistant can name it: "did it finish?". Claw
writes the item from what passes through it: a `prompt` command opens it (in progress, titled with the
machine, the agent and the start of the instruction), a `permissionRequest` puts it in front of the user
until its `permission_resolved`, the `turn_end` of the last prompt open closes it as answered with the end of
the agent's answer as its summary, and a `session_closed` closes it. Prompts and cancels for a session are
queued and noted one at a time, in the order the connector runs them: the end a cancel brings ends what was
sent before it, never a prompt sent after it, and a prompt the connector refused before queueing it
(`too_many_queued_prompts`, `session_closed`) counts as ended. The item keeps the command numbers of the prompts
open (`open_cmd_seqs`), and a connector that names the prompt a turn ends (`turn_end.cmd_seq`) is followed by
name: that end ends that prompt and no other, a refusal by name (`command_rejected`, including `cancelled` for a
prompt a cancel dropped) ends the prompt it names, and the end of a turn the item does not have open (one that
finished as a stop was on its way) ends nothing. The end a cancel brings (`stopReason: "cancelled"`, whether it
names the turn it cancelled or none) also ends every prompt still open that was sent before that cancel: one
whose turn's end never came (the connector restarted mid-turn, and does not run it again) ends with the next
stop. A `turn_end` without
`cmd_seq`, or a refusal of a prompt that never runs without one (a connector from before they were sent), makes
the item count again until it next reopens: with counting, two
stops in quick succession, with a turn ending on its own while the first cancel is on its way, can leave an
item in progress until its next turn ends. History a session had before its first prompt (a
conversation taken over replays it) is not applied, and each event is applied once. A prompt the user typed
into a chat attached to the session is told to nobody (the chat showed it, and the silent sweep skips these
items); one the assistant sent is told only three things, each once: it finished, it needs the user (a
permission request, its options carried as `remote.ask` on the `assistant.say` so a channel puts them to the
user as buttons, answered with `POST .../sessions/:id/decisions` as an attached chat's card is), or it failed
(the turn ended in `error` or `refusal`, the machine refused the instruction, or the session closed before it
finished). Each such message carries `remote: {kind: done|needs_you|error, session_id, machine, agent, ask?}`,
so a channel that already shows that session (a chat attached to it) can tell it did. The router's item list
says, for each, the agent, the session, whether its machine is online now, and the machine's name as quoted
data, but not the item's summary or question: those are the agent's own words (its answer, a tool's title).
`work_recall(item, "worker_tail")` reads the end of the agent's answer, and the turn that does has read
untrusted text. `work_send` refuses these items; `work_stop` and the item's stop button
(`POST /v1/work-items/:id/stop`) close one and cancel the agent's turn.

### Sending an instruction (`devenv_send`)

`devenv_send{text, agent?, target?, cwd?, new_session?}` sends an instruction to an agent on one of the user's own
machines. It chooses the machine and agent itself, among the caller's connectors only: the one the user
named (by machine name, session label or session id), else the only online machine offering that agent;
more than one is `which_machine`, an offline one is `connector_offline`. It continues an idle session of
that agent open through Claw, else opens a new one in the agent's first root (or the folder named, which
must be under a root); a session working on something is never sent another (`busy`). `new_session: true`
(the user asked for a new session) never continues one: a new session is opened, beside the session named
when one was, on its machine and with its agent. A folder written `~` or `~/x` is read in the home folder the
agent's roots are in (the connector expands `~` in its roots to its account's home, which it does not report):
`/home/u/repo` as a root makes `~/x` mean `/home/u/x`; roots that show no home folder, or more than one, read
no `~` folder at all, and the folder must still be under a root. The card shows the folder as the machine names it. The prompt goes
through the same checks as the user's own route (session limit, command rate, audit with the prompt's hash
only), under a command id derived from the card (`cmdKey("card", confirmationId)`), so pressing it twice
sends nothing twice.

Nothing is ever sent from the turn, not even one answering the user's own message sent signed in: a command
run on the user's machine is theirs to let through. Every instruction is put to them as a card (a held write,
`claw_assistant_confirmations` kind `devenv_send`, showing the text, the machine, the session and the
folder, answered by `POST /v1/assistant/confirmations/:id/decision` signed in, or by replying `批准 #<ref>`),
and is sent only then, after checking again that the machine is online and the session idle. The tool's
answer carries `why_card`: `confirm_first`, or why the turn could not have acted anyway (`read_untrusted`,
`not_attended`). Where cards are off (`CLAW_TRIGGERS_ENABLED` and `CLAW_TRIGGER_TOOLS_ENABLED` not both on) it is
refused with `cards_off`. A turn answering no message (a worker's report) cannot even propose it. What a machine
reported reaches the model only after the choice, and the turn has read it from then on.

## Retention

A closed session is deleted with all of its events `CLAW_REMOTE_AGENTS_RETENTION_DAYS`
days (default 30) after it closed; each API replica checks hourly. Zero or less keeps
them for ever. Live sessions are never deleted, and neither is the audit trail. Presence
transitions older than the same number of days go in the same sweep.

## Audit

`claw_remote_audit` records who did what through which client (`X-Claw-Client`, a short
label): connector registered and revoked, session created, every command issued, every
permission requested and resolved. A prompt is recorded as its SHA-256 and length,
never its text. A queued command is deleted once a heartbeat acknowledges it, or after a day
unacknowledged (6 minutes for `session.new`, `prompt`, `set_mode` and `resume`, each recorded as
`command.expired`): an instruction nobody has collected for that long should not run.
