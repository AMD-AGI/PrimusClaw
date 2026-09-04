// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The only place a checkpoint becomes bytes, and the only place bytes become a
 * checkpoint again.
 *
 * This module deliberately imports nothing from `../events/`. That is the whole
 * structural point of it, and it is enforced by
 * scripts/lint-checkpoint-must-seal.sh.
 *
 * The bug it exists to prevent: a checkpoint is not observability output, it is
 * the conversation a resumed run replays to the model. It used to be written
 * through the same redactor that masks events on their way to NATS and the
 * event database, and that redactor mutates -- by design, because a log line
 * with a credential in it should not be stored verbatim. Applied to replayable
 * state the same behaviour deletes content: any resumed session can come back
 * with `<redacted>` standing where a file path, a directory name or a word from
 * the middle of an identifier used to be, because the substring pass matches on
 * shape rather than on provenance. The agent returns having lost what it was
 * working on, and the turn is a guaranteed total prompt-cache miss because the
 * bytes no longer match what had been sent.
 *
 * Confidentiality is then a separate problem with a separate answer. The bucket
 * holds every user's prompts, file contents and tool output; NATS here runs
 * with one shared credential, no TLS and no encryption at rest, so "it does not
 * leave the Brain" was never the argument it looked like. v4 answers it with
 * cryptography instead of string substitution -- which also means it does not
 * depend on predicting how a secret might be spelled, the weakness the
 * substring pass always had.
 *
 * ── The v4 layout ────────────────────────────────────────────────────────────
 *
 * A plaintext envelope carrying only identifiers and counters, plus one sealed
 * blob holding the conversation:
 *
 *   { version: 4, session_id, message_id, user_id, turns_completed,
 *     has_workspace_sync, last_sync_turn, checkpointed_at, seq, state_enc }
 *
 * The envelope is readable so that the admin route, the reaper's key scan and
 * any operator with `nats kv get` keep working on the fields they actually use.
 * `messages` and `text_parts` are not fields of it at all: a reader that has no
 * key cannot see conversation content because there is none to see, rather than
 * because it was asked not to look.
 *
 * The gzip before sealing is not an optimisation. The KV stream runs with
 * `compression=s2`, and ciphertext does not compress, so without it the stream
 * loses a compression ratio it currently gets for free.
 *
 * AAD binds each blob to the session id, message id, user id and format
 * version of the run the reader believes it is loading. Without it, anyone able
 * to write the bucket could move run A's sealed conversation onto run B's key
 * and have B replay it -- the reader authenticates a checkpoint by a
 * `message_id` field that lives inside the same writable value, so it would
 * accept the move. With it, the open fails. The envelope counters are checked
 * against their sealed copies for the same reason: everything outside the seal
 * is attacker-writable, so nothing outside it may be trusted on its own.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { sealAead, openAead, AeadOpenError } from "@claw/utils";
import type { CheckpointState } from "../agent/index.js";

/** Fields every checkpoint carries in the clear, whatever its version. */
export interface CheckpointEnvelope {
  session_id: string;
  message_id: string;
  user_id: string;
  has_workspace_sync: boolean;
  last_sync_turn: number;
  checkpointed_at: number;
  turns_completed: number;
  /**
   * Monotonic within the writing process. A post-workspace-sync rewrite that
   * loses a race with a later turn would otherwise put an older conversation
   * back under the same key; the writer drops a write whose seq went backwards.
   * Process-local only -- a stale pod can still overwrite a newer checkpoint,
   * which is pre-existing and needs KV revision CAS to fix properly.
   */
  seq: number;
}

export type DecodedCheckpoint = { envelope: CheckpointEnvelope; state: CheckpointState };

/** Why a read produced nothing. Every branch is labelled so a rollout is observable. */
export type DecodeFailure =
  | "absent"
  | "not_json"
  | "version_unsupported"
  | "schema_invalid"
  | "envelope_mismatch"
  | "seal_key_missing"
  | "seal_open_failed";

export type DecodeResult =
  | { ok: true; value: DecodedCheckpoint; version: 3 | 4 }
  | { ok: false; reason: DecodeFailure; version?: number };

function hasStateShape(v: unknown): v is CheckpointState {
  const s = v as CheckpointState | undefined;
  return !!s && Array.isArray(s.messages) && typeof s.turns_completed === "number";
}

/**
 * The identity a checkpoint is sealed against.
 *
 * Supplied by the caller from what it EXPECTS to be reading, never taken from
 * the payload. Deriving it from the envelope makes the seal self-consistent
 * rather than context-binding: the ciphertext would then authenticate whatever
 * identity travelled next to it, so lifting the whole object -- envelope and
 * all -- onto another run's key opens cleanly and replays one run's
 * conversation as another's. Binding to the reader's expectation is what makes
 * that fail.
 */
export interface CheckpointIdentity {
  sessionId: string;
  messageId: string;
  userId: string;
}

/**
 * The AAD bytes for one identity, encoded so that no two distinct identities
 * can produce the same bytes.
 *
 * A delimiter join cannot promise that. `"a|b"` joined to `"c"` and `"a"`
 * joined to `"b|c"` are the same string, so two runs whose ids differ only in
 * where the boundary falls would share an AAD -- and a sealed conversation
 * could then be moved between them and still open. Nothing validates that a
 * session or message id contains no `|`; they arrive from the request.
 *
 * Each field is therefore length-prefixed with its byte length, which makes the
 * encoding injective: the decoder of these bytes (which nobody needs to write)
 * would recover exactly one field split, so exactly one identity maps to any
 * given AAD. The version is appended as a fixed-width field for the same
 * reason.
 */
function aadFor(id: CheckpointIdentity, version: number): Buffer {
  const parts: Buffer[] = [];
  for (const field of [id.sessionId, id.messageId, id.userId]) {
    const bytes = Buffer.from(field, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    parts.push(len, bytes);
  }
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(version);
  parts.push(ver);
  return Buffer.concat(parts);
}

/**
 * v3: the historical shape -- envelope fields and conversation flattened into
 * one plaintext object. Still written while CHECKPOINT_WRITE_VERSION is 3, and
 * still read forever, because a v3 checkpoint written by a pod that has not
 * rolled yet has to resume on one that has.
 */
export function encodeCheckpointV3(
  state: CheckpointState,
  env: CheckpointEnvelope,
  redact: (s: CheckpointState) => CheckpointState,
): Uint8Array {
  // v3 is plaintext in a bucket with one shared credential, so it keeps the
  // redactor it has always had -- lossy, but not a regression. The redactor is
  // a parameter rather than an import because this module must not be able to
  // reach `../events/`: that is the layering the lint enforces, and it is what
  // makes it impossible to accidentally apply the same mutation to v4.
  const { seq: _seq, ...rest } = env;
  return new TextEncoder().encode(JSON.stringify({ ...redact(state), ...rest, version: 3 }));
}

export function encodeCheckpointV4(
  state: CheckpointState,
  env: CheckpointEnvelope,
  key: Buffer,
): Uint8Array {
  const sealed = sealAead(
    key,
    gzipSync(Buffer.from(JSON.stringify({
      state,
      // Sealed copies of everything the envelope also carries in the clear, so
      // a rewritten envelope is detected rather than believed. checkpointed_at
      // is in here because the reader enforces a TTL with it: outside the
      // seal, anyone able to write the bucket could move an expired checkpoint
      // back inside its window.
      turns_completed: env.turns_completed,
      has_workspace_sync: env.has_workspace_sync,
      last_sync_turn: env.last_sync_turn,
      checkpointed_at: env.checkpointed_at,
      seq: env.seq,
    }), "utf8"), { level: 1 }),
    aadFor(
      { sessionId: env.session_id, messageId: env.message_id, userId: env.user_id },
      4,
    ),
  );
  return new TextEncoder().encode(JSON.stringify({ version: 4, ...env, state_enc: sealed }));
}

export function encodeCheckpoint(
  state: CheckpointState,
  env: CheckpointEnvelope,
  opts: {
    writeVersion: 3 | 4;
    key: Buffer | null;
    /** Applied on the v3 path only; v4 seals the state verbatim. */
    redactV3: (s: CheckpointState) => CheckpointState;
  },
): Uint8Array {
  if (opts.writeVersion === 4) {
    if (!opts.key) {
      // No fallback to a plaintext write. A deployment that asked for v4 and
      // cannot seal must stop, not quietly persist verbatim conversations to a
      // bucket whose whole threat model just changed.
      throw new Error("CHECKPOINT_WRITE_VERSION=4 requires BRAIN_CHECKPOINT_KEY");
    }
    return encodeCheckpointV4(state, env, opts.key);
  }
  return encodeCheckpointV3(state, env, opts.redactV3);
}

export function decodeCheckpoint(
  bytes: Uint8Array,
  key: Buffer | null,
  /**
   * Who the caller believes this checkpoint belongs to. Both the AAD and the
   * plaintext envelope are checked against it, so a payload that travelled
   * from another run fails to open rather than being trusted for saying it
   * belongs here.
   */
  expect: CheckpointIdentity,
): DecodeResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const version = raw.version;

  if (version === 3) {
    if (!hasStateShape(raw)) return { ok: false, reason: "schema_invalid", version: 3 };
    // v3 has no seal, so this is the only identity check it can get. It is
    // weaker than v4's by construction -- a writer can forge the fields it
    // compares -- which is another reason to move off it.
    if (
      String(raw.session_id ?? "") !== expect.sessionId
      || String(raw.message_id ?? "") !== expect.messageId
    ) {
      return { ok: false, reason: "envelope_mismatch", version: 3 };
    }
    const { version: _v, ...flat } = raw as Record<string, unknown>;
    return {
      ok: true,
      version: 3,
      value: {
        state: flat as unknown as CheckpointState,
        envelope: {
          session_id: String(raw.session_id ?? ""),
          message_id: String(raw.message_id ?? ""),
          user_id: String(raw.user_id ?? ""),
          has_workspace_sync: Boolean(raw.has_workspace_sync),
          last_sync_turn: Number(raw.last_sync_turn ?? 0),
          checkpointed_at: Number(raw.checkpointed_at ?? 0),
          turns_completed: Number((raw as { turns_completed?: number }).turns_completed ?? 0),
          seq: 0,
        },
      },
    };
  }

  if (version !== 4) return { ok: false, reason: "version_unsupported", version: Number(version) };
  if (!key) return { ok: false, reason: "seal_key_missing", version: 4 };

  const envelope: CheckpointEnvelope = {
    session_id: String(raw.session_id ?? ""),
    message_id: String(raw.message_id ?? ""),
    user_id: String(raw.user_id ?? ""),
    has_workspace_sync: Boolean(raw.has_workspace_sync),
    last_sync_turn: Number(raw.last_sync_turn ?? 0),
    checkpointed_at: Number(raw.checkpointed_at ?? 0),
    turns_completed: Number(raw.turns_completed ?? 0),
    seq: Number(raw.seq ?? 0),
  };
  if (typeof raw.state_enc !== "string") {
    return { ok: false, reason: "schema_invalid", version: 4 };
  }

  let inner: {
    state?: unknown; turns_completed?: number; has_workspace_sync?: boolean;
    last_sync_turn?: number; checkpointed_at?: number; seq?: number;
  };
  try {
    inner = JSON.parse(gunzipSync(
      openAead(key, raw.state_enc, aadFor(expect, 4)),
    ).toString("utf8"));
  } catch (e) {
    if (e instanceof AeadOpenError) return { ok: false, reason: "seal_open_failed", version: 4 };
    // A gunzip or JSON failure after a successful open means the plaintext is
    // not what this codec wrote, which is the same unusable outcome.
    return { ok: false, reason: "schema_invalid", version: 4 };
  }
  if (!hasStateShape(inner.state)) return { ok: false, reason: "schema_invalid", version: 4 };

  // Torn write: the envelope and the sealed core disagree about how far the run
  // had got. Resuming from either half would rewind or advance state that other
  // guards (the rebuild budget, the plan-mode latch) depend on being accurate.
  if (
    inner.turns_completed !== envelope.turns_completed
    || inner.has_workspace_sync !== envelope.has_workspace_sync
    || inner.last_sync_turn !== envelope.last_sync_turn
    || inner.checkpointed_at !== envelope.checkpointed_at
    || inner.seq !== envelope.seq
    // The AAD already proves the ciphertext was sealed for this identity; this
    // catches a plaintext envelope rewritten to disagree with it, which would
    // otherwise feed the caller a session_id the seal never covered.
    || envelope.session_id !== expect.sessionId
    || envelope.message_id !== expect.messageId
    || envelope.user_id !== expect.userId
  ) {
    return { ok: false, reason: "envelope_mismatch", version: 4 };
  }

  return { ok: true, version: 4, value: { envelope, state: inner.state } };
}
