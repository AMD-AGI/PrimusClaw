# Dispatch event bus

A dispatch control plane above Claw publishes its terminal events onto Claw's
NATS. Claw hosts the bus and owns the stream; it does not publish to it and, for
now, nothing reads it.

## What Claw provides

| | |
|---|---|
| Server | `primus-claw-nats.primus-claw.svc.cluster.local:4222` |
| Account | `PROD` — the same JetStream namespace Claw's own streams live in |
| User | `dispatch`, password from `NATS_PASSWORD_DISPATCH` in the operator's credentials file |
| Permissions | publish `<prefix>.>`, subscribe `_INBOX.>`, nothing else |
| Stream | `PRIMUS_DISPATCH_EVENTS`, subjects `<prefix>.>` |
| Retention | `max_age` 7 days, `max_msgs` 100 000, `retention: limits` |
| Replicas | `DISPATCH_STREAM_REPLICAS`, defaulting to `NATS_REPLICAS` (3) |

`<prefix>` is `DISPATCH_SUBJECT_PREFIX`, default `dispatch.v1`. The publisher
chooses it and lives outside this repo, which is why it is configuration rather
than a constant: a deployment whose dispatcher publishes under another prefix
sets this instead of running a stream that matches nothing it sends. The same
setting renders the account's publish permission, so the two cannot drift — a
permission for one prefix and a stream for another is a publisher that
authenticates and then has nowhere to publish.

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

The publisher runs in another namespace. The Claw chart ships no NetworkPolicy,
so in a default cluster this is open and there is nothing to configure. A
cluster that adds default-deny policies must allow it explicitly — Claw cannot
assert this from inside its own namespace, so it is the one item here that is
not code.

## Publisher contract

Owned by the publisher; Claw does not validate it and records it only so the
retention above can be read against something concrete.

```
<prefix>.run.succeeded
<prefix>.run.failed
<prefix>.session.dispatched

{task_id, run_id, state, verdict, stop_reason, ts}
```

Payloads carry ids and state only; a consumer that needs detail calls back to
the dispatcher's own API.
