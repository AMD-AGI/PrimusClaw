// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A pod leaving a rolling update hands its notification deliveries over instead of stranding them.
 *
 * A claim leases a row to the process for CLAIM_LEASE_SECONDS. A closing pod used to claim a row its pools could no longer send
 * (2026-11-07 07:14Z: a review handoff, kicked in the pod's last milliseconds, reached the person two minutes late, when the lease ran
 * out and another replica took it). Now the shutdown stops delivery before the pools end:
 *
 *   N1 a round in flight finishes before the pools may end
 *   N2 after it, a kick claims nothing: another replica's poll sends the row
 *   N3 the step runs before the pools end, in the shutdown index.ts installs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { db } from "../src/infra/db.js";
import { __resumeNotificationDeliveryForTest, kickDelivery, stopNotificationDelivery } from "../src/notifications/outbox.js";

const originalQuery = db.query;
after(() => { db.query = originalQuery; __resumeNotificationDeliveryForTest(); });

/** A database whose claim waits on `open`, and which records every statement. */
function slowClaims() {
  const seen: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push(sql);
    if (/^UPDATE claw_notification_outbox SET attempts/.test(sql)) await gate;
    return { rows: [], rowCount: 0 };
  }) as unknown as typeof db.query;
  return { seen, open };
}

const claims = (seen: string[]) => seen.filter((s) => /^UPDATE claw_notification_outbox SET attempts/.test(s)).length;

test("N1 + N2 the round in flight finishes before the stop does, and a kick after it claims nothing", async () => {
  __resumeNotificationDeliveryForTest();
  const db1 = slowClaims();
  const round = kickDelivery({ allowedHosts: new Set() });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(claims(db1.seen), 1, "a serving process claims");

  let stopped = false;
  const stopping = stopNotificationDelivery().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stopped, false, "the stop waits for the round it found");
  db1.open();
  await round;
  await stopping;
  assert.equal(stopped, true);

  await kickDelivery({ allowedHosts: new Set() });
  assert.equal(claims(db1.seen), 1, "a closing process claims nothing more");
});

test("N3 the shutdown stops delivery before the pools end", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const at = (name: string) => index.indexOf(`{ name: "${name}"`);
  assert.ok(at("notifications") > 0, "a notifications step");
  assert.match(index, /\{ name: "notifications", run: \(\) => stopNotificationDelivery\(\) \}/);
  assert.ok(at("notifications") < at("db"), "before the pools end");
});
