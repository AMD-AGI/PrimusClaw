# Run status API

The run API exposes platform lifecycle facts without task prompts, captures, or
workload-specific result vocabulary. Authentication and session ownership use the same
rules as the task API.

## Run identity

A run is identified by `run_id`, and only by `run_id`. It is the `ktsk_...` value that
the endpoint which started the run returns, and it is what every read below resolves.

A session is not a second name for a run. A session is the container a run belongs to,
and it holds any number of them -- a DAG expands to a root plus one run per node, a
batch to one of those per input, a chat to one per turn, and a retry clones a further
one. Filtering by session is for discovery and reconciliation; it cannot tell you which
run a particular request started.

Keep the `run_id` from the response that started the run:

| Endpoint | Where the run ID is |
| --- | --- |
| `POST /v1/sessions` with a `message` | `data.message.run_id` |
| `POST /v1/sessions/{id}/messages`, dispatched | `run_id` |
| `POST /v1/sessions/{id}/tasks`, single task | `task_id` |
| `POST /v1/sessions/{id}/tasks`, DAG | `dag_root_task_id`, and `task_ids` per node |
| `POST /v1/batches` | `dag_root_task_ids`, one per input |
| `POST /v1/workbenches/{id}/runs` | `run_id` |
| `POST /v1/tasks/{id}/retry` | `new_task_id` |

`POST /v1/sessions` without a `message` starts no run and returns no run ID.

A message sent while the session is still running a turn is accepted onto a queue and
answers `{"queued": true, "message_id": ...}` with **no** `run_id` (`message_id` is the one
the turn that runs it will carry, as its events do): the run row is opened later, when the
turn in front of it finishes. There is no ID to report yet, and one minted at accept
time would answer 404 here until the queue drains -- and would name nothing at all if
the queued message is later refused a workspace or its admission. Poll the session, or
filter by session ID as described below, until the run appears. A future release makes
this path create its run up front so that every accepted input has an ID; see
"Compatibility" at the end.

## Read one or more known runs

```text
GET /v1/runs/{run_id}
GET /v1/runs?ids={run_id},{run_id}
```

`ids` matches `run_id` exactly. Runs that do not exist or are outside the caller's
sessions are absent from `runs`; `requested` reports how many unique IDs were asked for.
Each result includes its phase and, once terminal, the platform's classification and
kill reason. Every result also carries the `session_id` it belongs to.

`ids` accepts at most 500 unique IDs. Over the cap is a 400 (`too_many_ids`) rather than
a trimmed answer, and `max_ids` on that response names the limit that applied.

## Find the runs of a session

```text
GET /v1/runs?session_ids={session_id},{session_id}
```

A collection filter, not a way of naming a run. Use it to enumerate what a session has
run, or to reconcile dispatches whose IDs were lost; use `ids` when you know which run
you mean.

Because a session owns many runs, this returns more runs than IDs it was given, and
`requested` is a count of sessions asked about rather than of runs to expect back. Group
the answer by each run's `session_id`. A session with no runs back either has none or is
not yours -- the two are deliberately indistinguishable, so that the endpoint cannot be
used to discover which sessions exist.

`session_ids` accepts at most 350 unique IDs, fewer than `ids` allows. A session ID is a
UUID, and 500 of them exceed the HTTP request-line limit, which fails as a bodyless 431
rather than as a readable error. Read `max_ids` off the `too_many_ids` response rather
than hard-coding either number.

A single call returns at most 1000 runs. Beyond that it is a 400 (`too_many_runs`, with
`max_runs`) rather than a truncated page: a short answer would be indistinguishable from
those sessions having only that many runs. Ask about fewer sessions.

## Query errors common to every form

Supplying both `ids` and `session_ids` in one call is a 400
(`ids_and_session_ids_are_exclusive`) rather than an intersection: the two name runs by
different keys, and a caller sending both has not established which one it holds. An
empty value still counts as supplying the parameter.

Supplying any parameter more than once -- `?ids=a&ids=b` -- is a 400
(`repeated_query_parameter`). Send one comma-separated value instead.

Neither `ids` nor `session_ids` may be combined with `cursor`
(`cursor_not_allowed_with_ids`); pagination applies to the terminal walk below.

## The terminal block

A terminal run carries `class`, `kill_reason`, `exit_code`, `signal`, `failure_reason`
and `failure_message`.

`failure_reason` is Claw's own code for how the run failed, `""` when none was
recorded. It is what separates a run that never started from one that ran and broke,
which `class` and `kill_reason` do not: both are `failed` / `""`. A run whose sandbox
never became usable records one of the provisioning codes --
`sandbox_workload_terminal`, `sandbox_exited_before_ready`, `sandbox_container_failed`,
`sandbox_envd_exited`, `sandbox_timed_out`, `sandbox_pending_timeout`, `sandbox_unschedulable`,
`sandbox_start_timeout`,
`sandbox_status_unreadable`, `sandbox_gone`, `sandbox_create_failed`, `sandbox_rejected`,
`sandbox_workspace_forbidden`,
`sandbox_image_missing`, `sandbox_auth_missing`, `sandbox_template_missing`,
`sandbox_health_failed`, `sandbox_bootstrap_failed` -- and nothing in it executed.

A run whose turn asked for a sandbox and never got one is `failed` with the code of the last
attempt even when its agent went on to answer without one: the answer is in the session, but
none of the work that needed the sandbox ran. That covers a create the platform refused
(`sandbox_rejected`: any 4xx but 403, 408, 425 and 429, such as an admission webhook's denial;
it is not sent again within the run), a create that failed (`sandbox_create_failed`: a 5xx, a 408,
425 or 429, or no answer; such a create is retried, and the run fails with this code once it has
no retry left, or reaches its deadline while the create is failing), a workload that failed before it was ready (its terminal code, such as
`sandbox_workload_terminal`), and no capacity (`sandbox_unschedulable`, `sandbox_pending_timeout`,
`sandbox_start_timeout`). An account the platform refuses a sandbox to
(`sandbox_workspace_forbidden`, `sandbox_workspace_not_allowed`) is not such a failure: its
turns carry on without one by design.

Such a run's `class` is `failed`, except after a provisioning timeout (`sandbox_pending_timeout`,
`sandbox_timed_out`, `sandbox_start_timeout`): that is a deadline, so when the platform gave no
other account of the sandbox (a preemption, say) the run reads `class: killed`,
`kill_reason: deadline`. Its status is `failed` and `failure_reason` is the code either way.

`failure_message` is what happened, for a person, when the run recorded more than its code:
for a sandbox the platform could not provide, the platform's reason (for example
`workload ... could not be scheduled: ...`, `workload ... still waiting for capacity after
10800.0s ...`, `workload ... entered terminal phase=failed (AdminFailed: ...)`, or
`The platform refused to create the sandbox (HTTP 400): admission webhook "vworkload.kb.io"
denied the request: ... timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox
The run asked for timeout=61200s; Claw adds 3600s to stop the run cleanly and sent
timeout=64800s, above the platform's limit of 10800s.`; when the requested timeout fits and
only the hour Claw adds does not, it also says the largest timeout that fits). `""` when
nothing more was recorded. The same code and message are on the session's `sandboxStatus` event
(`status: failed`), the A2A task's status message (text, and `metadata.failure_reason`) and
the `run.failed` notification's `summary` (`<code>: <message>`).

`exit_code` is `null` when no exit code was ever reported -- most often because the
run's worker went away with its node. Null means unknown; it is not a success and not
a failure, and callers must not read it as `0`. `signal` is `""` unless the exit code
genuinely encodes one (`128 + N` for a signal number `N`); an exit status that names
no signal is reported without one rather than given an invented name.

## App runs

A run of a hosted application (`mode: "app"`) carries an `app` block, on every form of
`GET /v1/runs` and on `GET /v1/tasks/{id}` (as `item.app`). Every other run has
`app: null` on `GET /v1/runs`, and no `app` field on `GET /v1/tasks/{id}`. Both routes
read it from the same place and answer the same block.

```json
{
  "app": {
    "sandbox": {
      "state": "ended",
      "workload_id": "claw-1795239361812-sandbox-q8v4n",
      "since": "2026-11-21T05:41:12.384Z"
    },
    "outcome": {
      "cause": "exited",
      "returncode": 3,
      "final": true,
      "error": "Traceback (most recent call last): ... RuntimeError: dataset not found"
    }
  }
}
```

`sandbox.state` is where the run's own sandbox is, which the task's `status` does not
say: an app task reads `running` from the moment a worker accepts it, while its sandbox
may still be queued for capacity or pulling a large image.

| `sandbox.state` | Meaning |
| --- | --- |
| `pending` | No sandbox is running yet: it is being created, is queued, or is starting (image pull included). Also after a sandbox was lost and a new one is on its way. |
| `running` | The platform reported the sandbox Running. The application may be starting, running, or waiting to be restarted in it. |
| `ended` | The run is over and its sandbox was stopped; or the platform lost the sandbox and the run, with no restart left, is finishing without it. |

A run cancelled while its sandbox was still `pending` stays `pending` until it is
`ended`; it never reads `running`. `sandbox.workload_id` is the platform's workload of
the run's current sandbox, and once the run has ended the last one it had; `""` before
one was created (and while a replacement for a lost one is being created).
`sandbox.since` is when the sandbox entered its state, and also moves when a new
sandbox is started for the run; `null` for a run created before this field existed.
`placement.workload_id` on `GET /v1/runs` names the same workload for an app run.

`outcome` is `null` until the run has ended. Then:

- `cause` is one of the closed list below; no other value is sent.
- `returncode` is the return code the application wrote in its `exit.json`, `null` when
  it wrote none or the run ended another way.
- `final` is `exit.json`'s `final`: the application said its run was over. `false` for
  every other ending.
- `error` is the application's own `exit.json` `error`, or, for a `sandbox_*` cause,
  what the platform said about the sandbox it did not provide. Secrets are masked
  (before it is cut), it is folded onto one line and is at most 300 characters; `null`
  when there is nothing.

| `cause` | The run ended because |
| --- | --- |
| `exited` | The application wrote `exit.json` with `final: true`. It succeeded when `returncode` is `0`. |
| `restarts_exhausted` | The application exited (or could not be started) without `final`, and no restart was left (`restart.max_restarts`), or the platform took its sandbox away more times than a run is given. |
| `start_failed` | The application could not be started at all: the sandbox has no user data directory for its state, or the run could not be driven (no platform key). |
| `deadline` | The run reached `limits.max_runtime_sec` or its deadline. |
| `cancelled` | The run was cancelled, or its session was deleted. |
| `task_closed` | The run's task was closed by something other than the run (for example the lost-worker reaper) before the application ended. |
| `no_exit_record` | The run ended with no exit record. |
| `sandbox_rejected` | The platform refused to create the sandbox (`sandbox_rejected`, such as an admission webhook's quota denial, or the account or workspace refused: `sandbox_workspace_forbidden`, `sandbox_workspace_not_allowed`, `sandbox_placement_invalid`). |
| `sandbox_create_failed` | Every request to create the sandbox failed (a 5xx, or no answer) until the run reached its deadline. |
| `sandbox_unschedulable` | No node would take the sandbox (`sandbox_unschedulable`), or it waited for capacity past the ceiling (`sandbox_pending_timeout`). |
| `sandbox_start_timeout` | The sandbox was scheduled but did not become ready in time. |
| `sandbox_failed` | The sandbox failed or disappeared before it was ready for another reason (for example `sandbox_workload_terminal`). |

A `sandbox_*` cause is reported when the run ended because it never got a sandbox: on
its restart budget, or (for `sandbox_create_failed`) at its deadline. A run cancelled
or past its deadline while merely queued reads `cancelled` or `deadline`, with
`sandbox.state` saying where the sandbox was.

The task's `failure_reason` is unchanged and still carries the same text for a person
("app exited final with return code 3", "app run ended: restarts exhausted"); read
`app.outcome` instead of matching on it.

## Walk terminal runs

```text
GET /v1/runs?state=terminal&since={ISO-8601}&limit={1..1000}
GET /v1/runs?state=terminal&since={ISO-8601}&limit={1..1000}&cursor={opaque}
```

Without `ids` or `session_ids`, `state=terminal` is required. Other or missing state
values return 400; active runs should be queried by their known IDs.

Results are ordered by `(completed_at DESC NULLS LAST, task_id DESC)`. The first
request omits `cursor`; while `has_more` is true, pass `next_cursor` unchanged to the
next request and retain the same `since` lower bound. Clients must treat the cursor as
opaque. `next_cursor` is null on the final page.

The endpoint does not provide snapshot isolation across pages. Runs that become
terminal during a walk are visible to the next reconciliation pass using the same
persisted `since` watermark.

## Compatibility

`run_id` is the stable public identifier. It is currently the same value as the task
API's `task_id`, and it stays the public name for a run through the planned rename of
the underlying table; callers should store `run_id` and not depend on the two being
spelled the same.

A response cached under an `Idempotency-Key` by a release that predates `run_id` is
still replayed, and the replay resolves the field rather than handing back the older
shape: a stored `POST /v1/sessions` body whose `data.message` carries only a
`message_id` is answered with the id of the run that message opened, so a retry landing
on a day-old entry reads as it would have had the first call been made against this
release. Nothing is minted to fill the field. On the rare entry whose run cannot be
resolved the reply is returned as it was stored, without a `run_id`, which is to be read
the same way as the queued path below -- find the run by filtering on the session.

One gap remains, and it is the queued-message path described under "Run identity": a
message accepted while the session is busy has no run to name yet. A later release
creates that run when the input is accepted, at which point every response that accepts
work for execution carries a `run_id`. That change only adds an ID where there is
currently none; it does not change the meaning of any ID returned today.
