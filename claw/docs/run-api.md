# Run status API

The run API exposes platform lifecycle facts without task prompts, captures, or
workload-specific result vocabulary. Authentication and session ownership use the same
rules as the task API.

## Read one or more known runs

```text
GET /v1/runs/{task_id}
GET /v1/runs?ids={task_id},{task_id}
GET /v1/runs?session_ids={session_id},{session_id}
```

Runs can be named by either key. `ids` matches `task_id`, the `ktsk_...` value the task
API returns. `session_ids` matches `session_id`, the value `POST /v1/sessions` returns --
use this one if you kept the session rather than the task. Every result carries both, as
`run_id` and `session_id`.

Runs that do not exist or are outside the caller's sessions are absent from `runs`;
`requested` reports how many unique IDs were asked for. Each result includes its phase
and, once terminal, the platform's classification and kill reason.

A session owns any number of runs -- a DAG expands to a root plus one run per node, a
batch to one of those per input, a chat to one per turn -- so `session_ids` can return
more runs than IDs it was given, and `requested` is a count of sessions asked about
rather than of runs to expect. Group the answer by each run's `session_id`; a session
with no runs back is one that either has none or is not yours.

`ids` accepts at most 500 unique IDs and `session_ids` at most 350; over the cap is a
400 rather than a trimmed answer, and `max_ids` on that response names the limit that
applied. The two caps differ because a session ID is a UUID and 500 of them exceed the
HTTP request-line limit, which would fail as a bodyless 431 instead.

Supplying both `ids` and `session_ids` in one call is a 400
(`ids_and_session_ids_are_exclusive`) rather than an intersection: the two name runs by
different keys, and a caller sending both has not established which one it holds.

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
