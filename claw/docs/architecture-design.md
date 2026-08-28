# PrimusClaw Architecture Design

> Brain/Hands separation, a stateless API tier, durable queue-driven execution,
> and file state with an identity of its own.

---

## Table of Contents

1. [Design Goals and Core Concepts](#1-design-goals-and-core-concepts)
2. [Overall Architecture](#2-overall-architecture)
3. [Component Responsibilities and Security Boundaries](#3-component-responsibilities-and-security-boundaries)
4. [Brain/Hands Communication Protocol](#4-brainhands-communication-protocol)
5. [Event Flow](#5-event-flow)
6. [Brain Fleet Coordination](#6-brain-fleet-coordination)
7. [Handling New Messages During Execution](#7-handling-new-messages-during-execution)
8. [Concurrency, Timing and Recovery](#8-concurrency-timing-and-recovery)
9. [Workspaces](#9-workspaces)
10. [Sandbox Lifecycle](#10-sandbox-lifecycle)
11. [Conversation Context and Memory](#11-conversation-context-and-memory)
12. [Statelessness and Horizontal Scaling](#12-statelessness-and-horizontal-scaling)
13. [Skills / MCP / Rules Ownership](#13-skills--mcp--rules-ownership)
14. [K8s Deployment Architecture](#14-k8s-deployment-architecture)
15. [Complete Request Lifecycle](#15-complete-request-lifecycle)
16. [Database Schema](#16-database-schema)
17. [Sub-Agent Concurrency](#17-sub-agent-concurrency)
18. [A2A Cross-System Agent Collaboration](#18-a2a-cross-system-agent-collaboration)
19. [Execution Template](#19-execution-template)
20. [Harness: Agent Orchestration Engine](#20-harness-agent-orchestration-engine)
21. [Skill Self-Evolution](#21-skill-self-evolution)
22. [Task DAG Orchestration](#22-task-dag-orchestration)
23. [Plugin System](#23-plugin-system)
24. [Batch Processing](#24-batch-processing)

---

## 1. Design Goals and Core Concepts

PrimusClaw runs LLM agents that touch real files and run real commands. The
architecture follows from two decisions. The model loop runs **outside** the sandbox,
holding the credentials; the tools run **inside** it, holding none. And every unit of
work is dispatched through a durable queue rather than sent to a chosen process, so that
no request depends on a particular pod being alive.

### 1.1 Design principles

**Credential containment by tier.** Platform control-plane credentials and upstream
storage keys live in the API and Brain tiers. The sandbox receives only what its own
caller already owns.

**Interchangeable workers.** No session is pinned to a Brain instance. Work is published
to a stream and pulled by whichever worker has capacity, which makes scaling and
restarting a matter of replica count rather than routing.

**Durable state, not in-process state.** Anything that must survive a restart lives in
PostgreSQL or NATS. Process memory holds only what is cheap to rebuild.

**Self-managed context.** The API assembles the model's message list from the database
each turn. There is no stateful SDK session to keep alive, so a conversation can be
resumed by any replica.

**Evidence over inference.** Reclaiming a resource requires a fact — a released
reference, an expired lease — rather than a guess derived from a timestamp.

### 1.2 Four concepts

Session, run, workspace and sandbox are separate objects with separate identities. Their
lifetimes are genuinely different, and conflating any two of them produces a class of
bug that is hard to see from inside either one.

| | What it is | Identity | Typical lifetime |
|---|---|---|---|
| **Session** | A conversation with a user, or a container for a body of work | `claw_sessions.session_id` | Days to months |
| **Run** | One execution: a chat turn, or one node of a DAG | `claw_tasks.task_id` | Seconds to hours |
| **Workspace** | A directory of files with an owner and a version | `claw_workspaces.workspace_id` | Outlives the runs and sessions that use it |
| **Sandbox** | The container the tools execute in | Provider workload id | Minutes |

Read down the lifetime column and it shortens, then lengthens again. A workspace outlives
the runs that write it; a sandbox does not outlive the run that opened it. That is the
reason the four cannot be collapsed into one object with one lifecycle.

The distinctions do specific work:

- A **session is not a run**, because a session has many turns and each needs its own
  execution record, deadline, owner and result.
- A **run is not a sandbox**, because a purely conversational turn needs no container at
  all, and because a container that dies should not by itself end the run.
- A **workspace is not a session**, because a user's files should survive the conversation
  that produced them, and because several sessions may work on the same directory.
- A **workspace is not a sandbox**, because the files are the durable thing and the
  container is the disposable one.

---

## 2. Overall Architecture

```
                        ┌──────────────────────────────┐
   client ── HTTP/SSE ──▶  API  (Fastify, N replicas)   │
                        │  routes, admission, context   │
                        │  event consumer, SSE          │
                        │  scheduler, sweeper, resolver │
                        └───┬──────────────┬────────────┘
                            │              │
                   PostgreSQL          NATS JetStream
                  (all durable       tasks.execute ──┐   events.>
                       state)                        │      ▲
                                                     ▼      │
                        ┌────────────────────────────┴──────┴───┐
                        │  Brain  (N replicas, shared durable)   │
                        │  agent loop, tool routing, LLM keys    │
                        └───┬─────────────────────────┬──────────┘
                            │ MCP over HTTP           │ object sync
                            ▼                         ▼
                    ┌───────────────┐          workspace storage (S3)
                    │ Hands sandbox │
                    │ /workspace    │
                    └───────────────┘
```

Three deployable components, all TypeScript, plus four external dependencies:
PostgreSQL for durable state, NATS for both streaming (JetStream) and coordination (KV),
S3 for workspace and asset storage, and a sandbox provider that creates containers on
demand — either SaFE's workload API or an agent-sandbox router, selected by
`CLAW_DEPLOY_MODE`.

A request never travels directly from the API to a named Brain. The API publishes an
execution request onto `tasks.execute`; a Brain replica pulls it from the shared durable
consumer, executes, and publishes events onto `events.<sessionId>`; the API persists
those events and serves them to clients. The only synchronous hop in the whole path is
Brain calling a tool inside its own sandbox.

---

## 3. Component Responsibilities and Security Boundaries

### 3.1 API

Fastify, multiple replicas, all interchangeable. It authenticates and authorises every
request, owns the PostgreSQL schema and its migrations, admits work into sessions,
assembles conversation context, publishes execution requests, persists the event stream,
and serves SSE.

It also hosts the background controllers: the DAG scheduler, the sweeper, the
external-wait resolver, the skill evolution worker, and daily maintenance. Controllers
that must run as singletons take a PostgreSQL advisory lock, so adding replicas does not
multiply them.

### 3.2 Brain

A fleet of identical workers, scaled by replica count. A worker pulls an execution
request, runs the agent loop against the model provider, decides where each tool call
goes, provisions and talks to sandboxes, syncs workspace files, and publishes events.

It holds the credentials the loop needs: the model gateway key, the sandbox provider
credentials, the platform internal token, and the upstream object-storage keys.

### 3.3 Hands

A small MCP server that runs inside the sandbox and exposes the filesystem and shell as
tools: `bash`, `bash_output`, `kill_shell`, `wait`, `read`, `write`, `edit`, `multi_edit`,
`notebook_edit`, `glob`, `grep`, `ls`, and presigned object transfer through
`upload_to_s3`, `download_from_s3` and `log_s3_upload_manifest`.

It holds no platform credentials and makes no outbound calls except to presigned URLs. It
authenticates every request on `/mcp` with a constant-time comparison against a bearer
token minted per sandbox.

### 3.4 Security boundaries

The sandbox is the boundary. Everything inside it is reachable by whatever the model
decides to run, so the question for each secret is not whether the tool layer hides it,
but whether the caller already owns it.

| Secret | API | Brain | Hands |
|---|---|---|---|
| Platform internal token, sandbox provider credentials | yes | yes | no |
| Upstream object-storage keys | yes | yes | no — presigned URLs only |
| User environment encryption key | yes | no | no |
| The caller's own model gateway key | passes through | yes | yes, by design |
| Per-sandbox internal token | mints | holds | yes |
| User and session environment variables | yes | yes | yes |

The caller's gateway key is injected into the sandbox under the names the model SDKs
expect, so that an agent working inside the sandbox can call a model itself. It is the
caller's own key, scoped to the caller, so exposing it to the caller's own sandbox grants
nothing they did not already have. Platform credentials are a different matter and never
cross the line.

File confinement is provided by the container, not by the tool layer. Path handling in
Hands resolves relative paths against the workspace root and deliberately permits absolute
paths, because mounted volumes outside the workspace are legitimate — and because a path
check at the tool layer would be bypassed by the first `bash` call anyway.

Two further partitions. Background shells are tagged with an owner and the owner is
enforced, so one run cannot observe or kill another's background job. And callbacks from
a run into the API authenticate with a token minted for that run, stored only as a hash on
the run's row, so a token recovered from one sandbox cannot drive another run.

---

## 4. Brain/Hands Communication Protocol

### 4.1 Transport

Brain calls Hands over MCP Streamable HTTP at `/mcp`, authenticated with the per-sandbox
bearer token and tagged with an owner header. Hands answers each call with a single JSON
response rather than a server-side event stream, because a tool call is a request/response
interaction and the streaming variant only adds failure modes.

Each call carries a deadline computed from the run's remaining budget, with a hard ceiling
of one hour. Work that legitimately outlives a foreground call is not meant to hold the
call open: `bash` accepts `run_in_background`, and the `wait` tool blocks on a background
shell without occupying a tool call.

### 4.2 Routing by boundary

Brain decides where each tool call executes. The rule is ownership: a call that touches
the user's files or processes goes to the sandbox; a call that uses platform credentials or
platform state stays in Brain; a call that must read or write platform data goes back to
the API.

| Call | Executes in |
|---|---|
| Filesystem, shell, notebook editing, object transfer | Hands, inside the sandbox |
| Web search and fetch, memory tools, skill tools | Brain |
| Sub-agent delegation (`task`), external agent calls (`a2a_call`) | Brain |
| `mcp__<server>__<tool>` for a configured MCP server | Brain's client for that server |
| Plugin tools declared with backend scope | The API, over the per-run backend MCP endpoint |

---

## 5. Event Flow

### 5.1 Shape

Brain publishes events directly to `events.<sessionId>` on JetStream. There is no callback
hop through the API for conversational events; the run reports to the stream, and the API
is one of the stream's consumers rather than a relay.

Two consumers read it. A durable consumer in the API persists every event into
`claw_session_events`, deduplicated on the event id and session id, and drives settlement
when a run completes. Each SSE connection creates its own ephemeral consumer filtered to a
single session, so an abandoned client leaves nothing behind on the server.

The stream keeps 24 hours of events, which bounds live replay only — the durable copy of
every event is in PostgreSQL.

### 5.2 Event vocabulary

A run emits status transitions (`statusUpdate`, `sandboxStatus`), model output
(`AssistantMessage`, `ThinkingMessage`, `ResultMessage`), tool activity (`toolUsed`),
accounting (`executionStats`), lifecycle interruptions (`taskInterrupted`, `taskResumed`),
script progress (`scriptStep`), and one terminal event (`exec_complete`).

`exec_complete` is a settlement signal rather than something a client renders: it is
persisted and drives completion handling, and it is filtered out of the client-facing
stream.

### 5.3 Serving history and live events together

`GET /v1/chat/sessions/:id/messages` serves conversation history followed by live events;
a replay mode returns the history as JSON instead. The subscription is established
*before* the history query runs, which closes the window in which an event published
between the two would be lost.

Event ids are derived from the stream sequence and are the same in the persisted copy and
the live one, so a client that reconnects can deduplicate against what it already has.
Sub-agent events can be delivered in full, folded into their parent, or filtered to a
single sub-agent.

---

## 6. Brain Fleet Coordination

Brain replicas are interchangeable, so coordination is about three questions: who does a
piece of work, who is entitled to keep doing it, and what happens when a worker
disappears.

### 6.1 Work distribution

One durable pull consumer, `brain-workers`, is shared by every replica. The API
provisions both the task stream and this consumer, and workers only read the resolved
configuration. Single ownership matters here: when every replica reconciled the consumer
on startup, the fleet's delivery ceiling became whichever pod restarted last, and a pod
configured lower silently lowered it for every replica already running.

Distribution needs no routing table and no service discovery. A worker with capacity pulls;
a worker without capacity does not.

### 6.2 Ownership and liveness

A worker that takes a run records itself on the run's row and renews a lease against the
API every 15 seconds; the row carries the owner, the expiry and the current phase. The
lease is the authoritative answer to "is anyone still working on this". It is refused with
a conflict if the API has already reassigned the run, and a worker that receives that
refusal aborts immediately rather than continuing to write into files it no longer owns.

Separately, for as long as a worker holds a queue message it sends a progress
acknowledgement every ten seconds. This covers the whole time it holds the message — while
it waits for an execution slot, through its admission checks, and across the agent loop —
so silence means the process is gone rather than that the work is slow.

### 6.3 Coordination state

Short-lived coordination state lives in NATS KV rather than in the database, because it is
keyed, expiring, and read on the hot path.

| Bucket | Keys | Purpose |
|---|---|---|
| Registry | `hands.<sessionId>` | Sandbox handle and readiness, for reuse |
| | `lock.<key>` | The run gate (§8) |
| | `brain.min_version` | Cooperative drain during rolling upgrades |
| Checkpoints | `task-ckpt.<sessionId>.<messageId>` | Resumable agent state |
| Tombstones | `deleted.<sessionId>` | Deletion markers |
| System env | `current` | Decrypted system environment, distributed to workers |

### 6.4 Interrupts and drain

Interrupts are published on core NATS at `interrupt.<sessionId>` and received by every
replica; only the one holding the matching abort controller acts. Broadcasting is cheaper
than maintaining a map of who holds what, and it is correct without one.

Rolling upgrades use a cooperative drain: the API publishes a minimum acceptable version,
and workers below it stop accepting new deliveries while finishing what they already hold.

---

## 7. Handling New Messages During Execution

A session executes one turn at a time. A message that arrives while a turn is running is
queued rather than rejected or merged into the running turn.

### 7.1 Message types

| Type | Behaviour |
|---|---|
| `text` | Next-turn semantics: dispatched immediately if the session is idle, queued if it is running |
| `inject` | Same next-turn semantics as `text` |
| `interrupt` | Published immediately on the interrupt subject; does not queue |
| Human decisions | A separate endpoint, so an approval is not competing with conversation for admission |

### 7.2 Admission

Admission takes a row lock on the session, which is what makes "is this session busy" a
decision rather than a race. If the session is running, the message is written to
`claw_pending_messages`; otherwise the session moves to running and dispatch proceeds
inside the same transaction.

A queued row carries a **complete snapshot** of what the message would have executed with:
credentials, tool and plugin selection, workspace, sandbox image and resources, timeout,
topology, and the user and session environment. Snapshotting at enqueue time is what makes
a queued turn behave the same whether it runs in one second or in twenty minutes; without
it, a message would silently pick up whatever configuration happened to be current when it
was finally dispatched.

### 7.3 Draining

When a run completes, the oldest queued message for that session is dispatched. Context and
skills are rebuilt at that moment rather than reused from enqueue time, because the
conversation has grown since. The queue row is deleted only after the stream has accepted
the publish, so a failed publish leaves the message in place to be retried rather than
losing it.

---

## 8. Concurrency, Timing and Recovery

Concurrency is controlled at three levels, each answering a different question, and
recovery rests on being able to distinguish a slow run from an absent worker.

### 8.1 Three gates

**Session admission** decides whether a *user* may start another turn in a conversation.
It serialises a conversation and queues rather than rejects (§7).

**The execution gate** is in-process and bounds what one pod attempts. It has two
ceilings. `MAX_CONCURRENT` bounds runs actively executing. `MAX_RESIDENT` bounds runs the
pod holds at all, executing or parked.

The second ceiling exists because a run that stops to wait — for a human approval, for a
background command — gives its execution slot back but keeps its sandbox and its in-memory
state. With only the first ceiling, a pod full of waiting runs would keep admitting new
work until it exhausted its memory. Every external wait point is wrapped so that entering
it parks the run and leaving it unparks, and unparking takes priority over admitting new
work.

**The run gate** decides whether two *runs* may proceed at once. It is a distributed lock
in NATS KV, created by compare-and-set, checked against its holder, and expiring on its
own so a dead worker's claim does not persist.

### 8.2 What the run gate is keyed on

This is the load-bearing detail. A run restores its workspace into the sandbox when it
opens, and syncs it back on the way out with a delete-enabled sync. If two runs writing the
same directory overlap, the second one's restore happens before the first one's sync: the
second starts from a stale copy, and its own sync then deletes whatever the first created.
Nothing errors. Files simply disappear.

So the gate must be keyed on the thing that determines which files a run writes, which is
the **workspace**. Keying on the session, or on the root of a DAG, is only a proxy for it —
two runs with different DAG roots can share one workspace — and the gap between the proxy
and the truth is exactly the case above. `RUN_GATE_KEY` selects the key, because
serialising runs that could otherwise overlap is a throughput decision as much as a safety
one, and a deployment that knows its runs never share a directory should be able to say so.

Keying on the workspace only works if every request carries one. A run that cannot be bound
to a workspace is therefore **refused rather than downgraded**: the API raises an error
instead of publishing, and a worker rejects any request that declares it requires a
workspace binding but carries no workspace.

The requirement travels as a declaration on the request rather than as an assumption in the
worker, because the two tiers are upgraded independently. A worker must be able to tell "no
workspace, and none was expected" from "no workspace, and one was required", and only the
publisher knows which it meant.

### 8.3 The timing contract

Five values must stay in a particular order. Violating the order does not produce an error;
it produces a race between two recovery mechanisms in which the loser corrupts something.

| Value | Default |
|---|---|
| Delivery heartbeat interval | 10s |
| Queue acknowledgement wait | 2m |
| Run lease renewal / TTL | 15s / 45s |
| Grace before a lost lease is reclaimed | 120s |
| Lock contention backoff ceiling | 10m |

**Heartbeat much shorter than acknowledgement wait.** Because a worker heartbeats for the
entire time it holds a message, the acknowledgement wait is not "how long a task may take".
It is how long after a pod goes silent the server waits before handing the message to
someone else. Two minutes is eleven missed heartbeats — longer than a slow garbage
collection or a brief reconnect, far shorter than the interval over which a human notices a
stuck conversation. The floor on shortening it is coverage: every legitimate way for a
worker to hold a message must be heartbeated.

**Lease TTL plus grace exceeds the acknowledgement wait.** When a pod dies, two mechanisms
want to act: the queue wants to redeliver, and the sweeper wants to reclaim the run.
Redelivery must win, because it resumes the work; reclaiming first would mark the run
failed moments before its replacement started.

**Stream retention covers the whole redelivery budget.** Stream age-based deletion does not
consult consumer state, so a retention shorter than the budget deletes messages the
consumer is still entitled to redeliver — and with them the guard that would have turned a
doomed run into a visible failure. Retention is therefore computed as
`maxDeliver × (acknowledgement wait + backoff ceiling)` rather than chosen, with the two
terms kept separate so that changing one does not silently invalidate the other.

**Tombstone lifetime equals stream retention.** A tombstone answers "was this session
deleted while this message was in flight", so it must outlive any message that could still
ask. Deriving it from the same budget keeps the two from drifting apart.

### 8.4 Failure modes

| What failed | How it is detected | What happens |
|---|---|---|
| The worker process | Heartbeat stops | The queue redelivers; the sweeper's reclaim waits out the grace period so redelivery wins |
| The worker's claim | Lease renewal refused with a conflict | The worker aborts its run immediately rather than writing into a workspace it no longer owns |
| The run itself, repeatedly | Delivery count approaches the ceiling | A guard fires one delivery inside the budget and resolves the run with a visible completion event, rather than letting the queue drop it silently |
| The session, deleted mid-flight | Tombstone present at admission | The message is discarded instead of resurrecting deleted work |
| An external wait that never resolves | Deadline on the run | The sweeper moves it to a terminal state |

---

## 9. Workspaces

A workspace is a directory of files with an identity, an owner and a version, independent
of any session or run that uses it.

### 9.1 Data model

Two tables. `claw_workspaces` holds the identity, owner, storage prefix, a monotonically
increasing version, a writer claim naming the run currently entitled to write, and a
retention deadline. `claw_workspace_refs` records who currently needs the workspace, one
row per holder with a release timestamp — a session holds one, and so does each run while
it executes.

### 9.2 Reclamation

A workspace becomes eligible for collection when its last reference is released **and** a
retention window has since expired. The window, seven days by default, exists because
releasing is not the same as regretting: users delete a session and want the files back an
hour later.

Reference counting rather than timestamp inference is the point. A directory that has not
been modified for a month looks identical whether it is abandoned or waiting, so any
collector built on modification time is either too aggressive or, in practice, too timid to
delete anything at all. With references, the collector has a fact to act on.

Collection itself is biased toward keeping data: references present means keep; retention
expired with no references means collect; and an ownership check that cannot be completed
means keep. A collector that cannot confirm a workspace is unwanted does nothing.

### 9.3 Concurrent writers

The writer claim is a short lease naming the run entitled to write, and the version
supports compare-and-swap for callers that need to detect a concurrent change rather than
merely avoid one. Neither replaces the run gate in §8; they cover the cases the gate is not
positioned to see, and they make contention observable rather than silent.

### 9.4 Persistence

Files are persisted to object storage under the workspace's prefix. A run restores them
when it opens its sandbox and syncs back periodically, at checkpoints, on shutdown signal,
and at completion — not only at the end, so that a killed pod does not discard an hour of
work.

---

## 10. Sandbox Lifecycle

A sandbox belongs to a run, not to a session, and many runs need none at all.

### 10.1 On-demand attachment

A conversational turn begins with no sandbox and reports its sandbox state as deferred. The
first tool call that actually needs a filesystem or a shell triggers attachment, enforced
centrally in the tool router so that no individual tool has to remember to check.

Two things follow. A turn that only produces text — a large share of them — never pays for
a container and never fails because one could not be scheduled. And the sandbox becomes a
resource acquired at the moment of need, which is what makes it reasonable to release it
during long waits.

Runs that obviously need a container up front — script mode, a resumed checkpoint, a
multi-node topology — skip the deferral.

### 10.2 Reuse and readiness

A ready sandbox is recorded in KV keyed by session and reused by later runs of that session.
An entry is only promoted to ready after bootstrap and health checks pass, so nothing
attaches to a half-built container. Stale entries are swept, and workloads orphaned by a
crashed worker are reclaimed by the sweeper using the workload id recorded on the run's row.

### 10.3 Environment handoff

User, session and system environment variables are handed to the sandbox through a file the
Hands process reads at startup, and are inherited by shell commands from there. Passing
them through a file rather than the workload spec keeps them out of process listings and
out of the cluster's object store.

### 10.4 Long-running work

Foreground tool calls have deadlines with a hard ceiling. Work that outlives one runs in a
background shell, owned by the run that started it, observed through `bash_output` and
awaited with `wait`. This is what lets a run park (§8) without losing the work in progress.

### 10.5 Provisioning timeouts

Two different clocks bound a sandbox, and they must not be confused:

- **`timeout` (request body / `sandbox_spec.timeout`, seconds)** — the sandbox's maximum
  **running** lifetime, forwarded to SaFE. SaFE counts it from `Status.StartTime`, which it
  writes when the workload **leaves the Pending queue and starts running** (not at dispatch —
  a workload is still Pending when marked dispatched). So it does **not** include time the
  workload spends **Pending** waiting for resources.
- **`SANDBOX_PENDING_TIMEOUT_SECONDS` (Brain config, default 3h)** — the ceiling on the
  **Pending/queue wait**. A readable Pending status (SaFE answering HTTP 2xx with a phase)
  is polled and waited on; if the workload has not reached Running within this window the
  whole message fails terminally with reason `sandbox_pending_timeout` (never retried).
  Set to `0` to wait forever.

A third, shorter net — `SANDBOX_POLL_TIMEOUT_MS` (default 1h) — is unrelated to healthy
queuing: it only fires when SaFE stops returning a **readable** status (persistent non-2xx,
fetch failures, or an unparseable/phase-less 2xx body), failing the message with reason
`sandbox_status_unreadable`. Every readable poll resets it, so a long but healthy queue wait
never trips it.

A fourth ends a wait for a workload that no longer exists: consecutive 404s past a limit
fail the message with reason `sandbox_gone`.

**These bound multi-node GPU clusters on the same terms.** Single-node sandboxes and
multi-node clusters are created with different bodies but waited on by one loop
(`sandbox/workload-wait.ts`), so the poll rhythm, the reading of a status, and all four ways
a wait can end are shared, as are the two settings above. What differs is per-topology and
declared at the call site: a sandbox is ready when its phase is Running, while an Infera
cluster also needs live role pod IPs, because external mode addresses its pods directly over
SSH. A cluster whose wait is given up on is DELETEd as part of giving up, so it stops holding
GPUs; a sandbox is left to the reaper.

---

## 11. Conversation Context and Memory

Context is assembled by the API from the database on every turn, so any replica can
continue any conversation.

### 11.1 Layers

**Recent turns** are the conversation's original text, stored in
`claw_conversation_turns` and replayed newest-first until the token budget is exhausted.
Tool calls and results are reconstructed into valid message sequences rather than flattened
into text. Turns are written for failures and interruptions too, so a failed turn remains
replayable.

**A session summary** compresses older turns once a session grows past its thresholds. It
is produced by a model call after settlement, never on the critical path, and falls back to
truncated concatenation if that call fails.

**Long-term memory** holds durable facts about a user across sessions, retrieved by
importance and recency, extracted automatically and writable explicitly by tool. Entries
decay over time and are removed once decayed and unused; a user profile is maintained as a
distinguished entry. Storage can be backed by the local database or delegated to an
external service.

### 11.2 Budget and assembly

The budget is fixed: the model window less a reserve for output and a reserve for tool
schemas. The system message is assembled in a fixed order — profile, long-term memories,
session summary, rules and any caller-supplied system text — followed by history and the
current prompt. Brain then merges its deployment rules into the system message and appends
the skill-enriched prompt.

Bulk tool output is stripped before entering future context; the full output remains in the
event record, so nothing is lost, but a single large command output does not consume the
window for the rest of the conversation.

### 11.3 Compaction within a run

A single long-running execution compacts its own conversation as it approaches the window.
This is separate from session summarisation: one operates within a run, the other between
runs, and they do not interact.

---

## 12. Statelessness and Horizontal Scaling

The API holds no state that a request depends on. Sessions, events, runs, workspaces,
memory and marketplace records are in PostgreSQL; queues, coordination and checkpoints are
in NATS. Process memory holds caches that can be rebuilt and connections that can be
reopened.

Two consequences shape the design. Any replica can serve any request, including an SSE
connection for a session whose run is executing on a different pod, because both the
history and the live feed are external. And singleton work — the schedulers, the sweeper,
maintenance — is elected rather than assumed, using an advisory lock, so replica count and
correctness are independent.

Brain is horizontally scalable in the same sense but is not stateless in the literal sense:
a worker holds the run it is executing, its abort controller, its gate counters and its
sandbox clients. What makes that safe is not the absence of state but its recoverability —
the run's authoritative record is a row, its liveness is a lease, and its resumable
position is a checkpoint.

---

## 13. Skills / MCP / Rules Ownership

Four kinds of configuration reach a run, from three owners.

**Skills** are versioned records with optional supporting files. The API selects which
skills a run receives based on the prompt, and sends them with the request. The main body
is inlined into the prompt; skills with supporting files are materialised into a directory
inside the sandbox so the agent can read them as files.

**Rules** are concatenated into the system message from three sources: deployment rules
loaded from disk and cached in the worker, rules attached to the run, and caller-supplied
system text.

**MCP servers** configured for the platform are connected from Brain, not from the sandbox,
because they hold platform credentials. Their tools appear to the model under a namespaced
name and are routed back to the right client.

**Hooks** are scripts staged into the sandbox and executed through Hands at lifecycle
points — session start, prompt submission, before and after a tool call, stop, session end.
They run where the work runs, which is the sandbox.

The division is consistent: content that describes *what to do* is assembled by the API and
carried in the request; anything that *executes* runs on the side of the boundary that owns
its credentials.

---

## 14. K8s Deployment Architecture

The Helm chart deploys:

- **API**, a Deployment of interchangeable replicas behind a Service and an ingress.
- **Brain**, a Deployment of interchangeable replicas, with a long termination grace period
  so a drain can finish, and an init container that waits for the schema migration.
- **PostgreSQL**, optionally as a managed cluster custom resource rather than a raw
  StatefulSet, so that backups, failover and version upgrades are the operator's job.
- **A workspace collector**, as a CronJob.
- **Configuration**, as a Secret and an optional sandbox template ConfigMap.

Sandboxes are not part of the chart. They are created at runtime through the sandbox
provider, into a namespace that must already exist — deployment-wide by default, or
per-workspace when the request names one.

NATS is an external dependency rather than a chart component, because it is shared
infrastructure with its own lifecycle.

Sizing is driven by a few values: replica counts for each tier, the two execution-gate
ceilings per Brain pod, and the fleet-wide unacknowledged ceiling on the shared consumer.
The last of these has to exceed replicas times per-pod concurrency plus the set of runs
backing off on a lock, since the queue counts those as outstanding; undersizing it stalls
delivery to every replica at once.

---

## 15. Complete Request Lifecycle

A conversational turn, end to end.

1. **Admission.** The request is authenticated and validated, the session row is locked, and
   the turn either queues (§7) or proceeds.

2. **Preparation.** The user message is persisted. Context is assembled (§11), skills are
   selected, and sandbox image and resources are resolved from the request, then the
   plugin, then defaults.

3. **Run creation.** A run row is created with its own callback token, deadline and
   workspace reference, and a lease is attached. The run is bound to a workspace, or the
   dispatch is refused (§8).

4. **Publication.** The execution request is published to the task subject. From here the
   API's involvement is as a consumer of events.

5. **Pickup.** A Brain replica pulls the message, begins heartbeating it, and acquires an
   execution slot.

6. **Admission checks.** Deletion tombstone, delivery count, local duplicate, workspace
   binding — then the run gate for the workspace, with backoff if it is held.

7. **Execution.** The worker begins renewing its lease. No sandbox is provisioned yet; the
   agent loop runs, and the first tool call that needs one attaches it (§10). Tool calls
   route by boundary (§4.2).

8. **Completion.** The worker emits accounting, syncs the workspace, writes a transcript,
   and publishes the terminal event — and only then acknowledges the queue message, so that
   a crash before that point results in redelivery rather than a lost turn.

9. **Settlement.** The API has been persisting events throughout. On the terminal event it
   closes the run, returns the session to idle, saves the conversation turns, records skill
   feedback and memories, and drains the next queued message. Settlement is idempotent, so a
   redelivered event cannot run it twice.

---

## 16. Database Schema

The schema is created and migrated by the API at startup, which is also the authoritative
reference for column-level detail. Foreign keys are deliberately not used for the run and
DAG tables; integrity is enforced in code, because the ordering constraints there are
temporal rather than referential.

| Table | Holds |
|---|---|
| `claw_sessions` | Conversations: status, agent status, mode, configuration, team and caller attribution |
| `claw_session_events` | Every event, deduplicated on event and session id |
| `claw_conversation_turns` | Replayable turns with tool calls and results |
| `claw_session_summaries` | Compression of older turns |
| `claw_pending_messages` | Queued turns with a full execution snapshot |
| `claw_idempotency_keys` | Replayed responses, scoped to user and route |
| `claw_tasks` | Every run — DAG nodes and conversational turns alike |
| `claw_task_edges` | DAG dependencies |
| `claw_task_dags` | Versioned DAG definitions |
| `claw_batches` | Batch fan-out records |
| `claw_workspaces`, `claw_workspace_refs` | Workspace identity, ownership and references |
| `claw_memory_entries` | Long-term memory and user profiles |
| `claw_skills`, `claw_skill_files`, `claw_skill_patterns`, `claw_evolution_jobs` | Skills, their assets, recurring patterns, and the evolution queue |
| `plugins`, `tools`, `resources` | Marketplace records |
| `claw_user_env_vars`, `claw_system_env_vars` | Encrypted environment variables |

`claw_tasks` is the centre of gravity. Its columns group into identity (run, session,
parent, batch, DAG and node, plugin, origin), definition (name, input, prompt, script,
mode, model, tool allowlist, skills, rules, hooks, sandbox spec, dependencies, priority),
binding and ownership (workspace, worker, sandbox workload, lease owner and expiry,
heartbeat, callback endpoints, token hash), state (status, failure reason, error message,
event sequence), results (output, artifacts, captures, tool statistics, token usage, turn
count, metadata) and timing (created, queued, started, deadline, completed).

Conversational turns write rows here too, which is what gives a chat turn a deadline, an
owner, a lease and an audit record — the same properties a DAG node has, for the same
reasons.

---

## 17. Sub-Agent Concurrency

A sub-agent is a nested agent loop with a fresh conversation and a restricted tool set,
started by the `task` tool and returning only its final text to the parent.

**In-process, shared sandbox.** Sub-agents run inside the same worker and share the parent's
sandbox and workspace. What isolates them is context, not infrastructure: a fresh message
list means the parent's conversation does not consume the sub-agent's window, and the
sub-agent's exploration does not pollute the parent's. Because the filesystem is shared,
concurrent writers among sub-agents can conflict with one another; the run gate operates
between runs and does not reach inside one.

**Permission profiles.** Each sub-agent takes a profile — exploration, read-only, shell, or
general purpose — and an explicit tool list can only narrow it further. Tools that write
global knowledge, and recursive delegation, are denied outright: a sub-agent is a
short-lived worker, and letting it modify durable state or spawn its own workers turns a
bounded delegation into an unbounded one.

**Parallelism.** Delegation calls issued in a single assistant turn run in bounded parallel
batches while ordinary tool calls stay serial; results are reordered to match the model's
original call order before they are returned. Depth and concurrency are both capped.

Events from a sub-agent are tagged with its id, type and depth, which is what lets the
client fold or filter them (§5.3).

---

## 18. A2A Cross-System Agent Collaboration

A2A is the protocol for talking to agents that are not part of this system. It sits above
sub-agent delegation: delegation creates a worker inside this process, A2A calls a peer
that has its own runtime, credentials and state.

### 18.1 As a client

Discovery reads the peer's agent card from its well-known location; invocation is JSON-RPC
against its endpoint. Three modes are supported: discovery alone, fire-and-forget, and
streaming, with timeouts scaled to each. A peer can be referenced by a configured name or
by URL, and a follow-up call can continue a previously created remote task.

### 18.2 As a server

The system publishes its own agent card, exposes an authenticated JSON-RPC endpoint, and
turns an incoming task into a real session — so external work gets the same execution,
persistence and observability as local work.

Incoming tasks may create child sessions carrying a parent session and a team role, which is
what makes persistent multi-agent teams possible rather than only one-shot calls. Callers
are attributed on the session row, and that attribution scopes what they can read, list and
cancel; one caller cannot see another's tasks.

### 18.3 Boundaries

Both directions are treated as untrusted. Outbound calls are bounded by timeouts and
produce results the model sees as tool output, not as instructions. Inbound calls are
authenticated, attributed, and admitted through the same path as any other work, so an
external caller cannot obtain concurrency or privileges a local caller could not.

---

## 19. Execution Template

An execution template is a named, reusable bundle of the choices that otherwise have to be
made per request: model, tool allowlist, skills, rules, hooks and system prompt. Selecting
one at session creation makes those choices once, so that "a frontend development session"
or "a data analysis session" is a thing a user picks rather than a configuration they
reassemble.

**Composition rather than a new mechanism.** A template introduces no execution machinery.
Each of its fields lands in the field of the execution request that already carries it: its
model and tool allowlist are the ones the run would otherwise take from defaults, its rules
join the system message alongside deployment rules, its skills join the selected set, and
its hooks join the plugin-provided ones. What a template adds is a name and a lifecycle for
that combination.

**Relationship to the neighbouring mechanisms.** Three other things in this system also
package configuration, and the boundaries need to be explicit or they overlap:

- A **plugin** packages *capabilities* — MCP servers, skills, rules, hooks — and can supply
  a sandbox image and resource defaults. A template may reference plugins; it does not
  replace them.
- A **task DAG** packages *a multi-step process*. Where a template configures how a single
  agent behaves, a DAG describes how several runs relate.
- A **workbench** packages *a scenario*, binding a DAG and a plugin for a particular use.

The natural division is that a template is the per-session default and everything more
specific overrides it: template, then plugin, then request. Overriding is a merge per field,
not a replacement of the whole bundle, because the alternative forces a caller who wants to
change the model to restate the tool list.

---

## 20. Harness: Agent Orchestration Engine

The harness is the loop between the model and the tools. It owns one turn's worth of
mechanics: build the message list, call the model, dispatch the tool calls it asks for,
insert the results, decide whether to continue, and emit events for everything that
happened.

### 20.1 Responsibilities

The loop is self-built rather than delegated to a vendor SDK. The reason is control over
the parts that matter operationally: which tools exist, where each one executes, what
happens when one fails, when to stop, and what state survives a restart. An SDK loop makes
those decisions internally and couples the system to its notion of a session.

Within a turn the harness handles model-protocol differences (the same loop drives either
an Anthropic-style or an OpenAI-style provider), plan mode and todo state, cancellation,
compaction as the window fills (§11.3), sandbox attachment on first need (§10.1),
recovery when a sandbox is rebuilt mid-run, and checkpointing.

### 20.2 Checkpointing and resumption

The loop writes its resumable position so that a run interrupted by a pod restart can
continue rather than start over. The granularity of that checkpoint sets what is
recoverable: a coarse checkpoint recovers the run, a per-step checkpoint recovers the
work done within it.

The same granularity determines whether a parked run (§8.1) can release its sandbox. A run
that keeps its state in memory must keep its container; a run whose state is durable at
each step can be evicted while it waits and rebuilt when it resumes. Whether that trade is
worth its complexity depends on the proportion of wall-clock time runs spend waiting rather
than executing, which the run's phase accounting records.

### 20.3 Programmability

Routing and error handling are code today, and the loop is configured per request rather
than programmed: model, turn cap, skills, rules, plugins, MCP servers, script mode,
sandbox and topology all arrive in the execution request.

The direction is to make more of it declarative — tool routing, retry and fallback policy,
loop control, and where checkpoints are taken — so that a new agent behaviour is a
definition rather than a change to the loop. The constraint on that direction is that each
policy made declarative must remain safe under every input, since a misconfigured policy
would fail in production rather than at compile time.

---

## 21. Skill Self-Evolution

Skills are instructions the agent reads to do a recurring task well. Self-evolution is the
machinery that improves them from evidence of how they actually performed.

### 21.1 Evidence

Attribution comes from behaviour, not intent: a skill counts as used when the run actually
read it. Each run contributes an outcome, turn count and error count against the specific
skill version in play, accumulating on the skill record as effectiveness counters.

### 21.2 Triggering

Evolution is considered only when there is enough evidence to act on: a minimum number of
executions of the current version within a recent window, and a symptom worth fixing — a
high failure rate, an excessive average turn count, or repeated errors. Below that
threshold, the difference between a bad skill and an unlucky week is not distinguishable,
and acting on it makes the skill worse.

Work is queued durably rather than performed inline, so a completion is never delayed by
analysis, and a worker crash does not lose the job.

### 21.3 Analysis and application

Analysis assembles the aggregate statistics, sampled successful and unsuccessful
trajectories, the current content and its supporting files, and asks the model for a batch
of mutations: edit the description, rewrite the body, change a supporting file, or create a
sibling skill for a case the current one handles badly.

A second model pass verifies the batch as a whole before anything is written, and the batch
is applied transactionally — all of it or none of it. Mutations are constrained: paths are
restricted, sizes are bounded, content is scanned, and duplicate targets within one batch
are rejected.

An improvement increments the skill's version in place, with the previous content retained
in history so a rollback is a restore rather than a reconstruction. A newly created sibling
starts in probation, since it has no evidence of its own yet.

### 21.4 Pattern promotion

Separately from improving existing skills, recurring successful work is detected across
sessions and, after enough occurrences of the same shape, promoted into a new skill. This
is the acquisition path; evolution is the refinement path.

---

## 22. Task DAG Orchestration

A DAG describes a multi-step process as nodes and dependencies. It is the mechanism for
work that is too structured for a conversation and too large for a single run.

### 22.1 Definition and instantiation

A DAG definition is stored once — versioned, with an input schema, an owner and a trust
level — and instantiated many times. Instantiation writes, in one transaction, a virtual
root, one execution row per node, and the edges. Nodes without dependencies start queued;
the rest start waiting on their dependencies.

Plugin defaults — image, resources, tools, skills, rules — are copied onto the rows at
instantiation. Copying rather than referencing is deliberate: editing a plugin must not
mutate a run already in flight.

### 22.2 States

| State | Meaning |
|---|---|
| `waiting_deps` | Blocked on upstream nodes |
| `queued` | Ready to dispatch |
| `preparing` | Claimed for dispatch; the execution message is going out |
| `running` | A worker has started it |
| `waiting_external` | Blocked on something outside the system |
| `cancelling` | Cancellation requested of a run already executing |
| `completed` / `failed` / `cancelled` | Terminal |

Transitions are applied as compare-and-set against the states each caller is willing to
accept, so two controllers acting on the same row cannot both win. Terminal states are
terminal: a retry creates a new row rather than reopening the old one, which keeps history
auditable and prevents a retried run from inheriting stale ownership.

### 22.3 Controllers

**The scheduler** promotes nodes whose dependencies have completed, cascades failure to
dependents, aggregates finished graphs into their root, and dispatches a bounded batch of
ready nodes.

**The dispatcher** claims a node, renders its templates, mints its callback credentials,
binds its workspace, and publishes it.

**The sweeper** is the safety net for everything that can stop without saying so: expired
deadlines, stuck roots, expired leases, expired external waits, stuck sessions, orphaned
sandbox workloads, and expired idempotency records.

The three are separate because they fail differently. A scheduler that stalls delays work;
a dispatcher that stalls delays one node; a sweeper that stalls leaks resources. Combining
them would couple those failure modes.

### 22.4 Templating within a node

A node's prompt, script and sandbox specification may reference the run, the session, the
batch, and the outputs of upstream nodes. This is how data flows along an edge: an upstream
node's output becomes a downstream node's input by reference rather than by the scheduler
concatenating text.

### 22.5 Relationship to sub-agents

A DAG node and a sub-agent both run work on behalf of something else, and the choice
between them is about durability. A DAG node is a row: it survives a restart, can be
retried, cancelled, and inspected long after the fact. A sub-agent is a function call
inside a run: it is cheap, it shares the workspace, and it disappears with its parent.

Structured, resumable, observable work is a DAG. Exploration in service of the current turn
is a sub-agent.

---

## 23. Plugin System

A plugin packages capabilities so that they can be shared, versioned and reused across
sessions: MCP servers, skills, rules and hooks, together with the sandbox image and
resource profile that work needs.

### 23.1 Model

A plugin record carries its identity, version, sandbox image and resource profile, and
references a set of tool records. Each tool record has a type — MCP server, skill, rule,
hook set, or prompt — and its own configuration, with larger assets kept in object storage
and fetched at execution time.

Tools are separate records rather than fields inside the plugin because they have their own
lifecycles: the same MCP server or the same rule set is used by several plugins, and a fix
to it should not require republishing each of them.

Records carry ownership and visibility, so a plugin can be private to its author or
published, and both listing and use are authorised against that.

### 23.2 Resolution

Configuration is resolved before execution and travels with the request, rather than being
looked up by the worker. This keeps the worker independent of the marketplace's
availability, and it makes a run reproducible: what it ran with is what was sent to it.

For structured work the resolution happens at instantiation and is copied onto the rows
(§22.1), so a long-running graph is not affected by a plugin changing underneath it.

### 23.3 Selection and settings

A run takes at most one plugin, which avoids the question of what happens when two plugins
supply conflicting rules or identically named tools.

Per-user installation — the set of plugins a user has adopted, their enabled state, and
their per-user settings and environment values — is the layer that turns the marketplace
into something personal. Its shape follows the same containment rule as everything else:
settings that name credentials are stored encrypted and resolved at dispatch, so the worker
receives values and never the key that protects them.

### 23.4 Boundaries

Hook scripts are validated before staging and execute inside the sandbox, where the work
runs. MCP servers configured by a plugin are connected from Brain, since they may hold
platform credentials; only tools explicitly declared as backend-scoped may call into the
API, and they do so over the run's own authenticated channel.

---

## 24. Batch Processing

Batch processing runs the same defined process over many inputs — evaluating a model
across a benchmark, applying a migration across many repositories, generating trajectories
for training.

### 24.1 Fan-out

A batch names a stored DAG and a list of inputs, and instantiates the graph once per input
inside a single transaction, tagging every resulting run with the batch identity. Doing the
fan-out transactionally matters: a partially created batch is worse than a rejected one,
because it looks complete.

From that point the ordinary scheduler drives the work. Batches deliberately do not have
their own execution path — the same dispatch, the same gates, the same recovery — because a
second execution path is a second set of failure modes to get right.

### 24.2 Settlement and aggregation

A batch is complete when every graph it created has reached a terminal state, and its record
carries that conclusion so a caller can ask about the batch rather than about its hundreds
of runs.

Aggregation is defined by the DAG rather than by the batch, since what constitutes a result
depends on the process: a benchmark wants scores per item and a summary, a migration wants
per-repository status, a data-generation run wants the trajectories themselves. The per-run
records already hold the raw material — output, artifacts, captures, tool statistics, token
usage and turn counts — so aggregation is a projection over them rather than a separate
collection mechanism.

### 24.3 Scale

The bound on a batch is not the batch mechanism but the fleet: the per-pod execution
ceilings and the fleet-wide unacknowledged ceiling (§8, §14). A batch of ten thousand
inputs is admitted as ten thousand rows and executed at whatever rate the fleet sustains,
which is why the fan-out is cheap and the queueing is where the backpressure lives.
