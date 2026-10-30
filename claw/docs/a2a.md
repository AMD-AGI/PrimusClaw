<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# A2A server

Claw serves the [A2A protocol](https://a2a-protocol.org) v1.0 over the JSON-RPC
binding: `POST <public url>/a2a` for the general agent and
`POST <public url>/a2a/plugins/<id>` for the agent that runs one plugin, with
the agent card at `<public url>/.well-known/agent-card.json` (and
`/a2a/plugins/<id>/.well-known/agent-card.json`, readable by a caller who may see the
plugin). A caller authenticates as it does for the rest of the API. Version 0.3
clients are refused with `VersionNotSupportedError`.

Everything below that says "with the switch on" is behind
`CLAW_A2A_CONTEXT_TASKS=true` (through the chart's `api.extraEnv`); with it unset
the server is the one it always was.

## Contexts and tasks

- A **context** is a session, owned by the authenticated caller, so the caller
  sees it in their own Claw. Its id is the `contextId` the caller names (or one
  the server mints). Another caller's context with the same id is another
  session.
- A **task** is one run of that session. A message with a `contextId` and no
  `taskId` starts a new task in the context, and Brain is given the turns the
  context already has, so a follow-up is a conversation.
- A context runs one task at a time. A message sent while one is running is
  refused with `UnsupportedOperationError` ("context busy", naming the task);
  wait for it, or cancel it. Sending the same `messageId` again returns the task
  it already started.
- A message with a `taskId` is only ever the **answer** to a task that is
  `INPUT_REQUIRED`; to a task in any other state it is refused.

| A2A state | When |
|---|---|
| `SUBMITTED` | admitted, Brain has not started yet |
| `WORKING` | Brain has a sandbox and is running |
| `INPUT_REQUIRED` | a tool call is held for approval, or the agent asked a question |
| `COMPLETED` / `FAILED` | the run ended; the result is an artifact (`<taskId>-text`, and `<taskId>-tools` for tool calls) |
| `CANCELED` | `CancelTask`, or the run was stopped |

## Answering a task that needs the caller

`status.message` of an `INPUT_REQUIRED` task has a text part (what is asked) and
a data part:

```json
{"kind": "approval", "actionId": "...", "tool": "bash", "input": {"command": "..."}, "options": ["allow", "deny"], "timeoutMs": 300000}
{"kind": "question", "actionId": "...", "questions": [{"id": "q1", "question": "...", "options": [{"id": "a", "label": "A"}]}]}
```

Reply with `SendMessage` carrying the `taskId` (and `contextId`): a data part
`{"decision": "allow" | "deny", "reason": "..."}` for an approval (a bare text
`allow` / `deny` is accepted too), and text or a data part
`{"answers": {...}}` for a question. The server publishes the same decision
message the web client sends, as the caller. `edit` and `remember` are not
offered. An approval nobody answers is refused when `HITL_DECISION_TIMEOUT_MS`
runs out. Questions need `ASK_USER_QUESTION_ENABLED` on Brain.

## Streams, long tasks, cancelling

`SendStreamingMessage` and `SubscribeToTask` send the task, then status and
artifact updates, and end when the task is finished or needs the caller. A
reconnecting client calls `SubscribeToTask`: its first event is the task as it
stands, text so far included. Events are not replayed, so a chunk written in the
instant between the snapshot and the subscription can appear in both.

A blocking `SendMessage` returns when the task finishes or needs the caller, or
after at most 120 seconds with the task as it is then. This is an intended
deviation from spec 3.2.2 (gateways cut idle connections): for a long task send
with `returnImmediately: true` and poll with `GetTask`, or stream.

`CancelTask` publishes the interrupt Brain listens for, so the run stops; the
task reads `CANCELED` at once and the context takes a new task when the worker
has wound down.

## The agent card

With the switch on the card describes the one way in (a `chat` skill; a plugin
agent lists the plugin's own skills), declares its security with the v1.0 shape
(`securityRequirements: [{"schemes": {"bearer": {"list": []}}}]`) and carries
`ETag` and `Cache-Control` (the generic card is public for five minutes; a
plugin card is private and revalidated, and a refusal is never cached). When the
identity client and `CLAW_IDENTITY_TOKEN_AUTH_ENABLED` are on and an issuer is
configured, the card also offers `openIdConnectSecurityScheme` with the
provider's discovery URL.

## Callers authenticated by an identity provider

An access token's `act.sub` (who acted for the user) and `client_id` are
recorded in the run's `metadata.a2a` beside the caller. They grant nothing: the
caller is the token's `sub`. Such a caller has no virtual key, so its runs are
paid for by the deployment's shared LLM key; with the switch on, only the
clients named in `CLAW_A2A_IDENTITY_CLIENT_IDS` (comma separated) may use A2A,
and an empty list refuses them all with 403. API keys, cookies and the other
credentials are not asked.

## Push notifications

With `CLAW_A2A_PUSH_ENABLED=true` a client registers a webhook for a task
(`CreateTaskPushNotificationConfig`, or `configuration.taskPushNotificationConfig`
on the send; `Get`, `List` and `Delete` too) and is sent a `StreamResponse` when
the task changes state: running, `INPUT_REQUIRED` with the request, working
again, and at the end the whole result as one artifact followed by the final
status. A task takes five configs, and a config's id is the task's own: two
callers, or two tasks of one caller, can each use the same id. A config goes with
its task's last notification, however the run ended: the completion event writes
it, and a run that was closed without one (the sweeper's budget close, a stop
that was never confirmed) gets it from the push worker within about 30 seconds.

The receiver is authenticated with what the client supplied: the config's
`authentication` is sent as `Authorization: <scheme> <credentials>` and its
`token` as `X-A2A-Notification-Token`. v1.0.1 has no server-held signing key for
notifications, so none is published. Credentials are stored encrypted and never
returned.

A webhook must be https and must resolve to a public address. A host named in
`CLAW_A2A_PUSH_ALLOWED_HOSTS` (comma separated) is the operator's exception, the
only place plain http is accepted, for an in-cluster receiver. The check runs
when the config is created and again at every delivery, which connects to the
address that was checked. Delivery is at least once and in order per config,
retried with backoff and abandoned after an hour.

## Not supported

Extended agent cards, the REST and gRPC bindings, files as artifacts, and
exposing remote agents as A2A agents.
