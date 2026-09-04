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
answers `{"queued": true}` with **no** `run_id`: the run row is opened later, when the
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

A terminal run carries `class`, `kill_reason`, `exit_code`, and `signal`.

`exit_code` is `null` when no exit code was ever reported -- most often because the
run's worker went away with its node. Null means unknown; it is not a success and not
a failure, and callers must not read it as `0`. `signal` is `""` unless the exit code
genuinely encodes one (`128 + N` for a signal number `N`); an exit status that names
no signal is reported without one rather than given an invented name.

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

One gap remains, and it is the queued-message path described under "Run identity": a
message accepted while the session is busy has no run to name yet. A later release
creates that run when the input is accepted, at which point every response that accepts
work for execution carries a `run_id`. That change only adds an ID where there is
currently none; it does not change the meaning of any ID returned today.
