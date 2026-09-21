// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API destroys sandboxes out of the bucket Brain registers them in.
 *
 * This is the defect that made every other guarantee in this area vacuous, and
 * it is invisible at every level a test normally looks at. `sandbox-stopper`
 * read `infra/nats.kv`, which is `BRAIN_REGISTRY`; Brain writes handles to a
 * bucket of its own called `DAG_HANDLES`. Both sides used the same
 * `DagHandleMap`, the same key shape and the same encoding, and neither ever
 * errored -- the reader simply asked a bucket that had nothing in it.
 *
 * What that cost: every API-side teardown found an empty map and tore nothing
 * down, so a DAG's sandboxes outlived their DAG, on the cancel path, the
 * agent_done path and the sweeper alike. And it is exactly the shape of bug
 * this whole feature was asked to make visible, so shipping the report over the
 * top of it would have turned a silent leak into a confident `nothing_held` --
 * a worse outcome than the silence, because now something is asserting.
 *
 * A unit test cannot catch a name that is wrong but consistent, and an
 * integration test that stubs the registry cannot either. What does catch it is
 * pinning the two names to each other, since the bug is precisely that they
 * disagreed. Read from source because the two live in different packages and
 * the API's binding is a module-scoped `let` that only `initNats` fills.
 *
 * Coverage:
 *   B1 Brain's writer and the API's reader name the same bucket
 *   B2 the stopper reads that binding, not the short-lived registry one
 *   B3 the api user's NATS allow-list grants the bucket the code names
 *   B4 and no longer grants the one it does not
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DAG_HANDLES_BUCKET } from "../src/infra/nats.js";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
}

test("B1 Brain's handle writer and the API's handle reader name the same bucket", () => {
  const brain = read("../../brain/src/sandbox/handles.ts");
  const declared = /const BUCKET = "([A-Z_]+)"/.exec(brain)?.[1];

  assert.equal(
    declared, DAG_HANDLES_BUCKET,
    "the only writer and the only destroyer have to be looking at the same bucket; "
      + "when they were not, nothing failed and every sandbox leaked",
  );
});

test("B2 the stopper reads the DAG handles binding, not the short-lived registry", () => {
  const stopper = read("../src/tasks/sandbox-stopper.ts");

  // The binding, not the shape of the import line: this guard is about which
  // bucket the stopper reads, and pinning the exact import list made it fail
  // when a second name was added beside it.
  assert.match(
    stopper, /import \{[^}]*\bkvDagHandles\b[^}]*\} from "\.\.\/infra\/nats\.js"/s,
    "the handle map is built over the DAG handles bucket",
  );
  // `kv` is BRAIN_REGISTRY: five-minute TTL, sized for `lock.<key>`. A handle
  // has to outlive its DAG, which for a long evaluation is hours, so reading
  // handles from there loses the mapping even when the name is right.
  assert.equal(
    /\bkv as natsKv\b/.test(stopper), false,
    "BRAIN_REGISTRY is coordination state that expires; a handle mapping must not",
  );
});

test("B3 the api user's NATS allow-list grants the bucket the code names", () => {
  // The other half of why this survived, and the reason a code-only fix would
  // have failed in the cluster while passing every test here: the allow-list
  // agreed with the bug. It granted `$KV.BRAIN_REGISTRY.dag-handles.>`, a
  // permission for a key nobody has ever written, and nothing granted
  // KV_DAG_HANDLES at all. A denied publish does not raise in the NATS client,
  // so the failure mode is a teardown that silently does nothing -- which is
  // indistinguishable from the failure mode of the wrong bucket, and is the one
  // this whole PR exists to stop being invisible.
  const perms = read("../../../deploy/nats-values.yaml");
  // Grant lines only. Matching raw text would let a subject *named in a
  // comment* -- this file explains several -- read as a permission, which is
  // the same class of mistake as the allow-list agreeing with the bug.
  const granted = new Set(
    perms.slice(perms.indexOf("- user: api"), perms.indexOf("- user: brain"))
      .split("\n").map((l) => l.trim())
      .filter((l) => l.startsWith('- "'))
      .map((l) => l.slice(3, -1)),
  );

  // Every subject class the stopper reaches, each for a different operation:
  // put/delete is a publish, get is a direct read, and the sweeper's kv.keys()
  // builds an ordered consumer and tears it down again.
  for (const subject of [
    `$KV.${DAG_HANDLES_BUCKET}.dag-handles.*`,
    `$JS.API.STREAM.INFO.KV_${DAG_HANDLES_BUCKET}`,
    // No STREAM.CREATE or UPDATE, deliberately. This side binds to Brain's
    // bucket rather than ensuring it: `ensureKvBucket` corrects drift as well
    // as creating, so an attach carrying its own replica setting would rewrite
    // Brain's config on every boot. Row writes stay, because whoever stops a
    // workload frees its handle and this side stops them on cancel.
    `$JS.API.DIRECT.GET.KV_${DAG_HANDLES_BUCKET}.>`,
    `$JS.API.STREAM.MSG.GET.KV_${DAG_HANDLES_BUCKET}`,
    // Both forms. The server names an ordered consumer itself, so the request
    // subject has no trailing token -- and addresses it as <stream>.<name>
    // when it does. Asserting only the bare form let the `.>` grant be deleted
    // with this test still green and `kv.keys()` failing in the cluster.
    `$JS.API.CONSUMER.CREATE.KV_${DAG_HANDLES_BUCKET}`,
    `$JS.API.CONSUMER.CREATE.KV_${DAG_HANDLES_BUCKET}.>`,
    `$JS.API.CONSUMER.INFO.KV_${DAG_HANDLES_BUCKET}.>`,
    `$JS.API.CONSUMER.DELETE.KV_${DAG_HANDLES_BUCKET}.>`,
    // Without flow control, kv.keys() stops yielding -- without throwing --
    // once the bucket is big enough for the server to apply backpressure, so
    // the sweeper would silently see a short list of DAGs.
    `$JS.FC.KV_${DAG_HANDLES_BUCKET}.>`,
  ]) {
    assert.ok(
      granted.has(subject),
      `api cannot reach ${subject}, so this teardown fails silently in the cluster`,
    );
  }
});

test("B4 and no longer grants the bucket it does not use", () => {
  // Left behind, this is a standing invitation to put the code back: a grant
  // that describes a layout nothing implements, sitting in the file somebody
  // reads to find out what the layout is.
  // Grant lines only. The comment recording why the old subject was wrong has
  // to keep naming it, or the next reader loses the reason with the line.
  const granted = read("../../../deploy/nats-values.yaml")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- "'));

  assert.deepEqual(
    granted.filter((l) => l.includes("BRAIN_REGISTRY.dag-handles")), [],
    "handles never lived in BRAIN_REGISTRY; a grant saying they do is how this bug reads as intentional",
  );
});

test("B5 the retention reader uses filters NATS actually matches", async () => {
  // Round 45. `hands.retained-*` is not a wildcard -- NATS treats `*` as one
  // only when it is a whole token -- so that filter was a literal nobody
  // writes, the scan came back empty every time, and the gate never fired in
  // production. Nothing caught it because every test of that gate stubs the
  // method, so the filter itself was never executed.
  //
  // Checked against the key shapes Brain actually writes, taken from its own
  // key builders rather than restated here.
  const src = read("../src/tasks/sandbox-stopper.ts");
  const fn = src.slice(src.indexOf("async retained(workloadId: string)"));
  // Code only. The comment in there names the broken filter in order to explain
  // it, and a check that reads prose cannot tell the explanation from the bug --
  // this assertion failed on its own comment the first time.
  const body = fn.slice(0, fn.indexOf("\n  },"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  assert.equal(/hands\.retained-\*/.test(body), false,
    "a `*` mid-token matches nothing; that filter reads as an empty retention set");
  assert.match(body, /\$\{HANDS_KEY_PREFIX\}\*/,
    "the projection scan has to use a whole-token wildcard");
  assert.match(body, /\$\{RETENTION_LEDGER_PREFIX\}\*/,
    "and the ledger has to be scanned at all -- it is the authority the "
      + "projection is restored from");
  assert.match(body, /throw new Error\(`retention record/,
    "an unreadable record is not an absent one; the caller turns a throw into "
      + "`unconfirmed`");

  // The prefixes have to be the ones Brain writes. `retentionKey` builds
  // `hands.retained-<encoded>` and `retentionLedgerKey` builds
  // `retention.<encoded>`.
  const brain = read("../../brain/src/sandbox/retain-container.ts");
  assert.match(brain, /`\$\{HANDS_KEY_PREFIX\}\$\{RETAINED_PREFIX\}\$\{encodeKeyPart\(generation\)\}`/,
    "if Brain's projection key shape moves, this reader stops matching it");
  assert.match(brain, /export const RETENTION_LEDGER_PREFIX = "retention\.";/,
    "and the ledger prefix restated in the API has to be this one");
});
