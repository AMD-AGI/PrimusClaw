// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What this pod does with a doorbell whose declared contract it cannot meet,
 * in a process where the kill-switch is on. The off half is
 * doorbell-kill-switch.test.ts.
 */

import { registry } from "../src/infra/metrics.js";
import "./doorbell-api-base-env.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOORBELL_SEMANTICS_MAX, DOORBELL_SEMANTICS_VERSION, RUN_DOORBELL_KIND,
} from "@claw/protocol";

import { RUN_DOORBELL_DISPATCH, TASK_MAX_DELIVER } from "../src/config.js";
import { handleTask } from "../src/tasks/dispatch.js";
import { doorbellPayload, fakeDelivery, recordClaims } from "./doorbell-wire.js";

test("the switch defaults on, because a kill-switch is not killed by default", () => {
  assert.equal(RUN_DOORBELL_DISPATCH, true);
});

async function deliver(
  payload: unknown,
  opts: { deliveryCount?: number; claim?: () => Response } = {},
): Promise<{ verdicts: string[]; urls: string[] }> {
  const claims = recordClaims();
  if (opts.claim) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      claims.urls.push(String(input));
      return opts.claim!();
    }) as typeof globalThis.fetch;
    const restore = claims.restore;
    claims.restore = () => { globalThis.fetch = original; restore(); };
  }
  const { msg, verdicts } = fakeDelivery(payload, opts.deliveryCount ?? 1);
  try {
    await handleTask(msg);
  } finally {
    claims.restore();
  }
  return { verdicts, urls: claims.urls };
}

test("a doorbell above this binary's version is declined and acked", async () => {
  const r = await deliver(doorbellPayload({ semantics: DOORBELL_SEMANTICS_VERSION + 1 }));
  assert.deepEqual(r.verdicts, ["ack"]);
  assert.deepEqual(r.urls, [], "an unsupported doorbell must not be claimed");
});

test("a doorbell with no semantics field is treated as version 1 and claimed", async () => {
  // The stream still holds doorbells published before the field existed; one
  // that failed the type guard would be cast to an ExecuteRequest instead.
  const r = await deliver(doorbellPayload());
  assert.deepEqual(r.urls.length, 1, "a version-1 doorbell is claimed normally");
});

test("every declared semantics version through this binary's version is claimed", async () => {
  for (let semantics = 1; semantics <= DOORBELL_SEMANTICS_VERSION; semantics++) {
    const r = await deliver(doorbellPayload({ semantics }));
    assert.equal(r.urls.length, 1, `version ${semantics} must remain compatible`);
    assert.deepEqual(r.verdicts, ["ack"]);
  }
});

test("every malformed present value is declined, never read as compatible", async () => {
  // `semantics ?? 1` would accept each of these as "not greater than mine".
  for (const semantics of ["2", null, 0, -1, 1.5, Number.NaN, DOORBELL_SEMANTICS_MAX + 1]) {
    const r = await deliver({
      kind: RUN_DOORBELL_KIND,
      task_id: "ktsk_wire",
      session_id: "sess-wire",
      claim_url: "http://api/v1/internal/tasks/ktsk_wire/claim",
      semantics,
    });
    assert.deepEqual(r.verdicts, ["ack"], `expected ${String(semantics)} to be declined`);
    assert.deepEqual(r.urls, [], `expected no claim for ${String(semantics)}`);
  }
});

test("a claim that keeps throwing naks while deliveries remain", async () => {
  const r = await deliver(doorbellPayload(), {
    deliveryCount: 1,
    claim: () => new Response("boom", { status: 500 }),
  });
  assert.deepEqual(r.verdicts, ["nak:5000"]);
});

test("a claim throwing on the durable's last delivery terminates instead of naking", async () => {
  // A nak there stops redelivery with no log, no counter and no user-facing
  // event: the poison guard sits past the claim branch's own return and is
  // additionally gated on the claim having succeeded.
  const r = await deliver(doorbellPayload(), {
    deliveryCount: TASK_MAX_DELIVER - 1,
    claim: () => new Response("boom", { status: 500 }),
  });
  assert.deepEqual(r.verdicts, ["term"]);
});

/** One outcome's total on the claim counter, as a reader of `/metrics` sees it. */
async function claimOutcomes(outcome: "miss" | "terminated"): Promise<number> {
  const name = "claw_brain_doorbell_claim_outcome_total";
  for (const line of (await registry.metrics()).split("\n")) {
    if (!line.startsWith(`${name}{`) || !line.includes(`outcome="${outcome}"`)) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

test("a doorbell another pod claimed first is counted as the miss it was", async () => {
  // A lost race is a bare ack, so this counter is the only trace it leaves.
  // Counted as anything else, the miss rate reads zero and a claim path
  // failing open drops every doorbell with nothing to alert on.
  const before = [await claimOutcomes("miss"), await claimOutcomes("terminated")];

  const r = await deliver(doorbellPayload());

  assert.deepEqual(r.verdicts, ["ack"], "a lost race is acked, not retried");
  assert.equal(r.urls.length, 1, "the claim was attempted, and lost");
  assert.equal(await claimOutcomes("miss") - before[0], 1);
  assert.equal(
    await claimOutcomes("terminated") - before[1], 0,
    "a claim race is not a delivery this pod gave up on",
  );
});

async function declinedAs(reason: string): Promise<number> {
  const metric = registry.getSingleMetric("claw_brain_doorbell_declined_total");
  assert.ok(metric, "expected the doorbell decline counter to be registered");
  const { values } = await (metric as {
    get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
  }).get();
  return values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

test("a decline is counted under the reason it was declined for", async () => {
  // One series per reason is the whole point of the label: a corrupt or forged
  // payload and a fleet below its asserted floor are different incidents, and
  // an operator who cannot tell them apart on /metrics cannot act on either.
  const before = {
    unsupported: await declinedAs("semantics_unsupported"),
    malformed: await declinedAs("semantics_malformed"),
    killSwitch: await declinedAs("kill_switch"),
  };

  await deliver(doorbellPayload({ semantics: DOORBELL_SEMANTICS_VERSION + 1 }));
  await deliver({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_wire",
    session_id: "sess-wire",
    claim_url: "http://api/v1/internal/tasks/ktsk_wire/claim",
    semantics: "2",
  });

  assert.equal(
    await declinedAs("semantics_unsupported") - before.unsupported, 1,
    "a doorbell above this binary's version is counted as unsupported",
  );
  assert.equal(
    await declinedAs("semantics_malformed") - before.malformed, 1,
    "a malformed declared version is counted as malformed, not as unsupported",
  );
  assert.equal(
    await declinedAs("kill_switch") - before.killSwitch, 0,
    "this process's switch is on, so neither decline may land on the kill-switch series",
  );
});

/** The value of one `claw_brain_doorbell_declined_total` sample. */
async function declined(reason: string): Promise<number> {
  const m = registry.getSingleMetric("claw_brain_doorbell_declined_total");
  assert.ok(m, "the decline counter must be registered on the shared registry");
  const v = await m.get();
  return v.values.find((x) => x.labels?.reason === reason)?.value ?? 0;
}

test("a decline is counted under the reason it refused for, not under the switch", async () => {
  // The label is the whole signal. A fleet below its semantics floor and a
  // burst of forged payloads are the two things an operator has to act on, and
  // both are invisible if they arrive counted as an intentional switch-off --
  // which is the one cause that needs no action at all.
  const before = {
    unsupported: await declined("semantics_unsupported"),
    malformed: await declined("semantics_malformed"),
    killSwitch: await declined("kill_switch"),
  };

  await deliver(doorbellPayload({ semantics: DOORBELL_SEMANTICS_VERSION + 1 }));
  await deliver({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_label",
    session_id: "sess-label",
    claim_url: "http://api/v1/internal/tasks/ktsk_label/claim",
    semantics: "2",
  });

  assert.equal(
    await declined("semantics_unsupported"), before.unsupported + 1,
    "a fleet below the floor is reported as one",
  );
  assert.equal(
    await declined("semantics_malformed"), before.malformed + 1,
    "and a payload that does not parse is told apart from it",
  );
  assert.equal(
    await declined("kill_switch"), before.killSwitch,
    "this process has the switch on, so nothing here may be counted against it",
  );
});

/** One counter sample, or 0 when the series has not been touched yet. */
function claimOutcome(text: string, outcome: string): number {
  const name = "claw_brain_doorbell_claim_outcome_total{";
  const line = text.split("\n").find((sample) =>
    sample.startsWith(name) && sample.includes(`outcome="${outcome}"`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

test("a claim given up on at the delivery ceiling is counted as a termination, not a race", async () => {
  // A miss is two pods racing one doorbell and is expected to happen; a term is
  // the end of the road for that row. Booked as a miss, a systematically
  // unclaimable row is terminated with nothing to alert on.
  const before = await registry.metrics();
  await deliver(doorbellPayload(), {
    deliveryCount: TASK_MAX_DELIVER - 1,
    claim: () => new Response("boom", { status: 500 }),
  });
  const after = await registry.metrics();

  const moved = (outcome: string) => claimOutcome(after, outcome) - claimOutcome(before, outcome);
  assert.equal(moved("terminated"), 1, "the row was terminated, and only this counter says so");
  assert.equal(moved("miss"), 0, "a termination booked as an ordinary race raises no alert");
});
