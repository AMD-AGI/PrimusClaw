# Dispatch event bus

The dispatch control plane (Dispatron; `hld` in today's code and subjects)
publishes its terminal events onto Claw's NATS. Claw hosts the bus and owns the
stream; it does not publish to it and, for now, nothing reads it.

## What Claw provides

| | |
|---|---|
| Server | `primus-claw-nats.primus-claw.svc.cluster.local:4222` |
| Account | `PROD` — the same JetStream namespace Claw's own streams live in |
| User | `dispatch`, password from `NATS_PASSWORD_DISPATCH` in the operator's credentials file |
| Permissions | publish `hld.v1.>`, subscribe `_INBOX.>`, nothing else |
| Stream | `PRIMUS_DISPATCH_EVENTS`, subjects `hld.v1.>` |
| Retention | `max_age` 7 days, `max_msgs` 100 000, `retention: limits` |
| Replicas | `DISPATCH_STREAM_REPLICAS`, defaulting to `NATS_REPLICAS` (3) |

The stream is created and reconciled by `initNats` in
`packages/api/src/infra/nats.ts`, alongside Claw's own two. Nothing needs to be
provisioned by hand, and a first publish will not create a stream with defaults
nobody chose.

## Why these values

**Retention is a troubleshooting window, not a delivery guarantee.** Seven days
is long enough to reconstruct what was dispatched across a weekend; 100k
messages bounds a runaway publisher on a `fileStore` PVC shared with the streams
that carry Claw's real traffic. There is no subscriber yet — the events exist so
one can be added without a migration — so trimming the tail costs nothing today.
Both limits only ever widen on redeploy: `ensureStream` will raise a stream an
operator lengthened, never cut it back to the constants compiled in here.

**Publish-only, and the subscribe entry is not an exception to that.** A
JetStream publish waits for its acknowledgement on an inbox subject, so a
credential with no `_INBOX.>` subscribe times out on every publish that in fact
succeeded server-side — the worst of both outcomes. It grants no access to any
Claw subject.

**A user in `PROD` rather than an account of its own.** The stream lives in
PROD's JetStream namespace; a separate account is precisely the boundary that
would put it out of reach.

## Connectivity

Cross-namespace, from `pulse` to `primus-claw`. The Claw chart ships no
NetworkPolicy, so in a default cluster this is open and there is nothing to
configure. A cluster that adds default-deny policies must allow it explicitly —
Claw cannot assert this from inside its own namespace, so it is the one item
here that is not code.

## Subject naming

`hld` is the dispatcher's name today and is being changed to `dispatch`. The
subjects are versioned (`hld.v1.*`) so that rename lands as a new subject rather
than as a reinterpretation of this one, and the external contract
`/api/v1/orchestration/workloads` is unaffected either way.

The publisher's contract, for reference — Claw does not validate it:

```
hld.v1.run.succeeded
hld.v1.run.failed
hld.v1.session.dispatched

{task_id, run_id, state, verdict, stop_reason, ts}
```

Payloads carry ids and state only; a consumer that needs detail calls back to
`GET /hld/tasks/{id}`.
