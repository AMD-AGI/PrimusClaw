// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A checkpoint is replayable state, not a log line.
 *
 * The assertions below pull against each other on purpose. Weakening the
 * redactor to make the v4 fidelity test pass turns the v3 test red; sealing
 * nothing to make the round trip simpler turns the confidentiality test red;
 * dropping the envelope cross-check to simplify the reader turns the splice
 * test red. A change that satisfies all of them has kept the property.
 *
 * The fixtures are transcribed from the corpus this was diagnosed on: a model
 * root, a word that is also a git subcommand, and a path with that word inside
 * an identifier. Every one is >= 4 characters and every one appeared verbatim
 * in transcripts that came back from a resume with holes cut in them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeCheckpoint, decodeCheckpoint,
  type CheckpointEnvelope, type CheckpointIdentity,
} from "../src/tasks/checkpoint-codec.js";
import { redactEgressPayload } from "../src/events/redaction.js";
import type { CheckpointState } from "../src/agent/index.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const HF_TOKEN = `hf_${"b".repeat(34)}`;

const TRANSCRIPT =
  "sed -n '140,340p' /models/qwen3-8b/backends/remote_runner.py"
  + " && export MODEL_PATH=/models/qwen3-8b/Qwen3-8B";

/** What runtimeSecrets() yields for this run: the credential, not the config. */
const SECRETS = [HF_TOKEN];

function state(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    messages: [{ role: "assistant", content: TRANSCRIPT } as never],
    turns_completed: 7,
    usage: { input_tokens: 10, output_tokens: 2, cache_read: 0, cache_create: 0, turns: 7 },
    text_parts: [`done, token was ${HF_TOKEN}`],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 3,
    elapsed_ms_before: 1234,
    setup_commands: [],
    ...overrides,
  } as CheckpointState;
}

function envelope(overrides: Partial<CheckpointEnvelope> = {}): CheckpointEnvelope {
  return {
    session_id: "sess-a",
    message_id: "msg-a",
    user_id: "u1",
    has_workspace_sync: true,
    last_sync_turn: 6,
    checkpointed_at: 1_700_000_000_000,
    turns_completed: 7,
    seq: 4,
    ...overrides,
  };
}

const redactV3 = (s: CheckpointState) => redactEgressPayload(s, SECRETS);
const v4 = { writeVersion: 4 as const, key: KEY, redactV3 };
/** Who the reader believes it is loading. Never taken from the payload. */
const AS_A: CheckpointIdentity = { sessionId: "sess-a", messageId: "msg-a", userId: "u1" };
const AS_B: CheckpointIdentity = { sessionId: "sess-b", messageId: "msg-b", userId: "u1" };
const v3 = { writeVersion: 3 as const, key: null, redactV3 };

test("v4 replays the conversation exactly as it was sent", () => {
  const s = state();
  const decoded = decodeCheckpoint(encodeCheckpoint(s, envelope(), v4), KEY, AS_A);
  assert.ok(decoded.ok, `expected a decode, got ${!decoded.ok && decoded.reason}`);
  assert.deepEqual(decoded.value.state, s);
  assert.equal(
    (decoded.value.state.messages[0] as { content: string }).content,
    TRANSCRIPT,
    "not one character of a path or identifier may be missing",
  );
});

test("v4 is unreadable without the key, and not merely encoded", () => {
  const bytes = encodeCheckpoint(state(), envelope(), v4);
  const raw = new TextDecoder().decode(bytes);

  // Asserting `!raw.includes(...)` alone would be satisfied by base64, by gzip,
  // or by renaming a field. Assert the two things that actually matter: the
  // wrong key cannot open it, and the blob is not merely compressed.
  const wrongKey = decodeCheckpoint(bytes, OTHER_KEY, AS_A);
  assert.equal(wrongKey.ok, false);
  assert.equal(!wrongKey.ok && wrongKey.reason, "seal_open_failed");

  const missingKey = decodeCheckpoint(bytes, null, AS_A);
  assert.equal(!missingKey.ok && missingKey.reason, "seal_key_missing");

  const blob = Buffer.from(JSON.parse(raw).state_enc as string, "base64");
  assert.throws(() => gunzipSync(blob), "the sealed core must not be plain gzip");
});

test("the envelope carries counters and no conversation at all", () => {
  const raw = JSON.parse(
    new TextDecoder().decode(encodeCheckpoint(state(), envelope(), v4)),
  ) as Record<string, unknown>;

  // The admin route and the reaper read these in the clear and must keep working.
  assert.equal(raw.turns_completed, 7);
  assert.equal(raw.session_id, "sess-a");
  assert.equal(raw.has_workspace_sync, true);
  // And a reader without the key sees no conversation because there is none to
  // see -- not because it was asked politely not to look.
  assert.equal(raw.messages, undefined);
  assert.equal(raw.text_parts, undefined);
});

test("v3 still redacts on its way to the bucket", () => {
  // v3 is plaintext in a bucket with one shared credential. It keeps the lossy
  // behaviour it has always had; the fix for that is to write v4, not to start
  // writing verbatim conversations to an unencrypted bucket.
  const raw = new TextDecoder().decode(encodeCheckpoint(state(), envelope(), v3));
  assert.ok(!raw.includes(HF_TOKEN), "a live credential must not reach a v3 payload");
  assert.ok(raw.includes("<redacted>"));
});

test("a sealed core cannot be moved onto another run's key", () => {
  // The reader authenticates a checkpoint by a message_id that lives inside the
  // same writable value, so without AAD this splice would be accepted and run B
  // would replay run A's conversation.
  const a = JSON.parse(new TextDecoder().decode(
    encodeCheckpoint(state(), envelope({ session_id: "sess-a", message_id: "msg-a" }), v4),
  ));
  const b = JSON.parse(new TextDecoder().decode(
    encodeCheckpoint(state(), envelope({ session_id: "sess-b", message_id: "msg-b" }), v4),
  ));
  b.state_enc = a.state_enc;

  const spliced = decodeCheckpoint(new TextEncoder().encode(JSON.stringify(b)), KEY, AS_B);
  assert.equal(spliced.ok, false);
  assert.equal(!spliced.ok && spliced.reason, "seal_open_failed");
});

test("a whole checkpoint cannot be moved onto another run's key", () => {
  // The attack the first version of this file missed. Splicing ciphertext into
  // a foreign envelope was covered; carrying the envelope along with it was
  // not, and that was the easier attack. It worked, because the AAD was built
  // from the payload's own session id -- the seal authenticated whatever
  // identity travelled beside it, which is self-consistency, not binding.
  //
  // Nothing in the object is trusted for identity now: the reader supplies who
  // it believes it is loading, and the AAD is built from that.
  const bytes = encodeCheckpoint(
    state(), envelope({ session_id: "sess-a", message_id: "msg-a" }), v4,
  );
  const moved = decodeCheckpoint(bytes, KEY, AS_B);
  assert.equal(moved.ok, false, "run B must not be able to replay run A's conversation");
  assert.equal(!moved.ok && moved.reason, "seal_open_failed");
});

test("a v3 checkpoint from another run is refused too", () => {
  // Weaker than v4's -- a writer can forge the plaintext fields this compares
  // -- but leaving v3 with no check at all would make the older format the
  // way around the newer one's.
  const bytes = encodeCheckpoint(state(), envelope(), v3);
  const moved = decodeCheckpoint(bytes, KEY, AS_B);
  assert.equal(!moved.ok && moved.reason, "envelope_mismatch");
});

test("an expired checkpoint cannot be made current again", () => {
  // checkpointed_at drives the reader's TTL. Left outside the seal, anyone able
  // to write the bucket could push a stale conversation back into its window.
  const raw = JSON.parse(new TextDecoder().decode(
    encodeCheckpoint(state(), envelope(), v4),
  ));
  raw.checkpointed_at = raw.checkpointed_at + 86_400_000;
  const tampered = decodeCheckpoint(new TextEncoder().encode(JSON.stringify(raw)), KEY, AS_A);
  assert.equal(tampered.ok, false);
  assert.equal(!tampered.ok && tampered.reason, "envelope_mismatch");
});

test("a rewritten envelope counter is caught, not believed", () => {
  const raw = JSON.parse(new TextDecoder().decode(
    encodeCheckpoint(state(), envelope(), v4),
  ));
  raw.turns_completed = 999;

  const tampered = decodeCheckpoint(new TextEncoder().encode(JSON.stringify(raw)), KEY, AS_A);
  assert.equal(tampered.ok, false);
  assert.equal(
    !tampered.ok && tampered.reason,
    "envelope_mismatch",
    "everything outside the seal is writable, so nothing outside it may be trusted alone",
  );
});

test("a v3 checkpoint written by an older pod still resumes", () => {
  // The rollout depends on this: during a rolling update a run checkpointed by
  // a pod that has not restarted has to be resumable by one that has.
  const decoded = decodeCheckpoint(encodeCheckpoint(state(), envelope(), v3), KEY, AS_A);
  assert.ok(decoded.ok);
  assert.equal(decoded.version, 3);
  assert.equal(decoded.value.envelope.turns_completed, 7);
  assert.equal(decoded.value.state.turns_completed, 7);
});

test("the checkpoint codec cannot reach the egress redactor", () => {
  // The structural half of the fix. The redactor arrives as a parameter; if
  // this module can import it, someone will eventually call it here again.
  const src = readFileSync(
    fileURLToPath(new URL("../src/tasks/checkpoint-codec.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    !/from\s+"\.\.\/events\//.test(src),
    "checkpoint-codec must not import from ../events/",
  );
});

test("the checkpoint handed to the writer is a snapshot, not the live array", () => {
  // workingMessages is mutated in place (compaction does `length = 0` then
  // pushes), and the deep copy the redactor used to make is gone from this
  // path. Every other field in that literal is copied; this one has to be too,
  // or a write can serialize a conversation from after the counters next to it
  // were read.
  const src = readFileSync(
    fileURLToPath(new URL("../src/agent/agent-loop.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /messages:\s*this\.workingMessages\.slice\(\)/.test(src),
    "onCheckpoint must be handed this.workingMessages.slice()",
  );
});
