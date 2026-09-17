// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What config.ts says about DAG_HANDLES has to be what this process does to it.
 *
 * The comment above the replica settings used to say that either side may
 * create DAG_HANDLES, that "only this side reconciles it", and that "api
 * corrects the bucket once" -- none of which is true, and none of which has
 * been true in this package for as long as the binding has been `bindOnly`.
 * There is no DAG_HANDLES_REPLICAS here to mirror brain's, `ensureKvBuckets`
 * deliberately keeps the bucket out of the `ensureKvBucket` set, and
 * `bindDagHandles` attaches without ever stating an opinion about the
 * configuration. The comment described a reconcile that does not exist.
 *
 * That is not cosmetic on this repo. A comment asserting a correction nobody
 * performs is a fallback, and a fallback gets leaned on: this one was already
 * cited on a sibling review to argue that a wrong replica count on that bucket
 * self-heals. It does not. Brain bakes the count in on the single
 * `js.views.kv("DAG_HANDLES", ...)` call that can set it, and nothing on either
 * side touches it afterwards (nats-replicas-delivery.test.ts).
 *
 * So this pins the two against each other rather than pinning either alone.
 * The behaviour is re-derived here -- the module's exports, and the bucket
 * names that actually reach `ensure` -- and the prose is then held to it. If
 * somebody makes this side configure DAG_HANDLES, D2 stops demanding the
 * disclaimer and D3 starts demanding that the comment say so; the test is
 * about the two agreeing, not about any particular sentence surviving.
 *
 * What it can and cannot catch: it reads attribution, which is a subject
 * immediately followed by a verb of ownership ("this side reconciles", "api
 * corrects"). It will not catch a false claim phrased with enough distance
 * between the two, and it is scoped to config.ts because the neighbouring
 * files are other people's comments to keep honest. Both halves of the
 * original falsehood trip it, which is what it was written for.
 *
 * Coverage:
 *   D1 this side holds no setting for the bucket and never configures it
 *   D2 no comment here attributes creating or reconciling it to this side
 *   D3 the comment names the side that does create it, and the setting it uses
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KV } from "nats";

import {
  DAG_HANDLES_BUCKET, EVENT_STREAM_RETENTION_MS, ensureKvBuckets,
  type EnsureKvBucketOpts,
} from "../src/infra/nats.js";

const CONFIG_SRC = fileURLToPath(new URL("../src/config.ts", import.meta.url));

/**
 * Every bucket name this process opens with an opinion, plus what it bound.
 *
 * The call log rather than the returned handles: "never configured" is an
 * `ensure` that did not happen, which no handle can show.
 */
async function provisioning(): Promise<{ configured: string[]; dagHandles: KV }> {
  const configured: string[] = [];
  const ensure = async (name: string, _opts: EnsureKvBucketOpts): Promise<KV> => {
    configured.push(name);
    return {} as KV;
  };
  const sentinel = { __boundNotEnsured: true } as unknown as KV;
  const buckets = await ensureKvBuckets(
    { retentionMs: EVENT_STREAM_RETENTION_MS, measured: true },
    ensure,
    async () => sentinel,
  );
  assert.equal(buckets.dagHandles, sentinel,
    "the handle this process ends up holding has to be the bound one, or the call log "
    + "below is describing a code path the process does not take");
  return { configured, dagHandles: buckets.dagHandles };
}

/** Whether this process carries any setting of its own for that bucket. */
async function settingNames(): Promise<string[]> {
  const config = await import("../src/config.js") as Record<string, unknown>;
  return Object.keys(config).filter((k) => k.includes("DAG_HANDLES"));
}

/**
 * The `//` comment blocks of config.ts that name DAG_HANDLES, one string each,
 * whitespace normalised.
 *
 * Blocks, not lines: the claim under test spanned six lines and no single one
 * of them carried both the subject and the verb. A blank line ends a block --
 * which is also what separates this comment from the stream comment below it;
 * run together, a check on one is a check on whatever the other happens to say.
 */
function dagHandleComments(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of source.split("\n")) {
    const comment = /^\s*\/\/\s?(.*)$/.exec(line);
    if (comment) {
      current.push(comment[1]);
      continue;
    }
    if (current.length) blocks.push(current.join(" ").replace(/\s+/g, " ").trim());
    current = [];
  }
  if (current.length) blocks.push(current.join(" ").replace(/\s+/g, " ").trim());
  return blocks.filter((b) => b.includes("DAG_HANDLES"));
}

/**
 * Whether a block attributes an act of ownership to `subject`.
 *
 * Up to two words of slack, so "api first reconciles it" and "this side also
 * corrects it" read as claims while "on an api-first cluster it would create"
 * -- where the subject of the verb is something else entirely -- does not.
 */
function attributes(block: string, subject: string): boolean {
  const verbs = "creates|create|corrects|correct|reconciles|reconcile|configures|configure|owns|own";
  return new RegExp(`\\b${subject}\\b\\s+(?:\\w+\\s+){0,2}?(?:${verbs})\\b`, "i").test(block);
}

test("D1 this side holds no DAG_HANDLES setting and never configures the bucket", async () => {
  const { configured } = await provisioning();
  assert.equal(
    configured.includes(DAG_HANDLES_BUCKET), false,
    `${DAG_HANDLES_BUCKET} reached ensureKvBucket, which corrects drift as well as creating; `
    + `buckets configured from here: ${JSON.stringify(configured)}`,
  );
  assert.deepEqual(
    await settingNames(), [],
    "a DAG_HANDLES setting exported here is a replica count this process has no call that "
    + "can apply, which is how the comment came to describe one",
  );
});

test("D2 no comment here credits this side with creating or reconciling DAG_HANDLES", async () => {
  const { configured } = await provisioning();
  const thisSideConfigures = configured.includes(DAG_HANDLES_BUCKET);
  const blocks = dagHandleComments(readFileSync(CONFIG_SRC, "utf-8"));

  assert.ok(blocks.length > 0,
    "the absence of a DAG_HANDLES setting in a file that declares one for every other "
    + "bucket is the kind of gap somebody closes by adding one; deleting the explanation "
    + "is not the fix for it being wrong");

  for (const block of blocks) {
    for (const subject of ["this side", "this process", "api"]) {
      assert.equal(
        attributes(block, subject) && !thisSideConfigures, false,
        `config.ts credits "${subject}" with acting on ${DAG_HANDLES_BUCKET}, and no call in `
        + `this process does: ensureKvBuckets configured ${JSON.stringify(configured)}. `
        + `A correction nobody performs reads as a fallback, and this one was cited as one. `
        + `Block: "${block}"`,
      );
    }
  }
});

/**
 * The name of the setting that decides the bucket's replica count, read off
 * the one call that can apply it.
 *
 * From brain's source rather than written down here, for the reason B1 in
 * sandbox-handle-bucket.test.ts reads the bucket name the same way: the symbol
 * lives in another package, and a pointer this file merely asserts is a second
 * copy of the claim under test. Renaming it there and leaving config.ts sending
 * readers after the old name is the next version of this finding.
 */
function brainReplicaSetting(): string {
  const src = readFileSync(
    fileURLToPath(new URL("../../brain/src/sandbox/handles.ts", import.meta.url)), "utf-8",
  );
  const bucket = /const BUCKET = "([A-Z_]+)"/.exec(src)?.[1];
  assert.equal(bucket, DAG_HANDLES_BUCKET,
    "this scan is reading the wrong writer, so whatever it finds below sizes some other bucket");
  const setting = /js\.views\.kv\(\s*BUCKET\s*,\s*\{[^}]*replicas:\s*(\w+)/.exec(src)?.[1];
  assert.ok(setting,
    `nothing in brain's handles.ts passes a replica count to js.views.kv any more, so the `
    + `bucket is back on the JetStream default of one and config.ts is describing a setting `
    + `that stopped being applied`);
  return setting;
}

test("D3 the comment names the side that creates DAG_HANDLES and the setting it uses", () => {
  const blocks = dagHandleComments(readFileSync(CONFIG_SRC, "utf-8"));
  assert.ok(
    blocks.some((b) => attributes(b, "brain")),
    "which side owns the bucket is the whole content of this comment: the reader arriving "
    + "at a missing setting needs to be sent to the process that has it, not merely told "
    + "that this one does not. Blocks found: " + JSON.stringify(blocks),
  );

  // The name, not "the same env var". A reader who has just found no
  // DAG_HANDLES setting in this file is looking for the one that exists, and a
  // comment that gestures at brain's config without naming it sends them to a
  // 900-line file to search for a symbol they cannot spell. The version of this
  // comment that claimed a reconcile also never named it.
  const setting = brainReplicaSetting();
  assert.ok(
    blocks.some((b) => b.includes(setting)),
    `no comment here names ${setting}, the variable that actually sizes `
    + `${DAG_HANDLES_BUCKET}. Blocks found: ${JSON.stringify(blocks)}`,
  );
});
