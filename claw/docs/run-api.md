# Run status API

The run API exposes platform lifecycle facts without task prompts, captures, or
workload-specific result vocabulary. Authentication and session ownership use the same
rules as the task API.

## Read one or more known runs

```text
GET /v1/runs/{task_id}
GET /v1/runs?ids={task_id},{task_id}
```

The IDs form accepts at most 500 unique IDs. Runs that do not exist or are outside the
caller's sessions are absent from `runs`; `requested` reports how many unique IDs were
asked for. Each result includes its phase and, once terminal, the platform's
classification and kill reason.

## Walk terminal runs

```text
GET /v1/runs?state=terminal&since={ISO-8601}&limit={1..1000}
GET /v1/runs?state=terminal&since={ISO-8601}&limit={1..1000}&cursor={opaque}
```

Without `ids`, `state=terminal` is required. Other or missing state values return 400;
active runs should be queried by their known IDs.

Results are ordered by `(completed_at DESC NULLS LAST, task_id DESC)`. The first
request omits `cursor`; while `has_more` is true, pass `next_cursor` unchanged to the
next request and retain the same `since` lower bound. Clients must treat the cursor as
opaque. `next_cursor` is null on the final page.

The endpoint does not provide snapshot isolation across pages. Runs that become
terminal during a walk are visible to the next reconciliation pass using the same
persisted `since` watermark.
