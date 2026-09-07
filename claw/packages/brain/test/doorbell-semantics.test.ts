// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What this pod does with a doorbell whose declared contract it cannot meet,
 * in a process where the kill-switch is on. The off half is
 * doorbell-kill-switch.test.ts.
 */

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
