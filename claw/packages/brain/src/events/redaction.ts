// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// `isSensitiveKey` is shared with api's `redactPublicJson` rather than
// duplicated: both passes mask the same agent-loop events (here on the way into
// NATS, there on the way out over SSE), and a sensitive name added to one copy
// would have left the other leaking.
import { isSensitiveKey, looksLikeVersionString, redactSecrets } from "@claw/utils";

/**
 * Whether a credential value is distinctive enough to hunt by substring.
 *
 * Everything reaching this was nominated by runtimeSecrets(), on one of three
 * grounds: it is one of the run's own credentials, or its env var's NAME reads
 * as a credential, or the VALUE itself is shaped like one. Only the first of
 * those is certain, so the question here is not "is this secret" -- for two of
 * the three grounds that is a guess -- but "will replacing it every time it
 * appears also destroy ordinary text". The pass is a blind substring
 * replace over payloads that are logged, streamed to users, and replayed to
 * the model, and what it cuts out of a replayed payload is gone for good.
 *
 * A flat length floor answered that badly in both directions. At 16 it dropped
 * `DB_PASSWORD=hunter2`, which is a live credential and only seven characters.
 * Low enough to catch that, it would excise `true` from every command in the
 * transcript the moment someone named a boolean `FEATURE_TOKEN`.
 *
 * Distinctiveness is the property that actually separates them. A value that
 * is a bare word, a bare number, or a boolean spelling collides with prose by
 * construction and cannot be hunted safely whatever its name says -- mask the
 * field by key name and leave the substring pass out of it. Anything else --
 * digits mixed with letters, punctuation, or simply long -- does not appear in
 * a transcript by accident. Casing is not one of the signals; see below.
 *
 * Applied to every candidate, whichever rule nominated it. runtimeSecrets()
 * collects on two grounds now -- the name reads as a credential, or the value
 * itself is shaped like one -- and a value that cannot be hunted safely cannot
 * be hunted safely for either reason. The check lives at the point of use, so
 * there is one place it can be applied and no way for a new collection rule to
 * arrive without it.
 */
const ORDINARY_WORD_RE = /^[A-Za-z]+$/;
const ORDINARY_NUMBER_RE = /^[0-9]+([.,][0-9]+)?$/;
/**
 * A word with digits stuck on the end: `word2`, `getUserById2`, `v2`.
 *
 * This is the one place where the two directions cannot both be served, so it
 * is written down rather than decided quietly. `hunter2` and `getUserById2`
 * are the same string shape. There is no predicate that hunts the password and
 * spares the identifier, and both really occur: `DB_PASSWORD=hunter2` was the
 * regression that put the distinctiveness rule here in the first place, and
 * `call getUserById2` is a line out of any transcript.
 *
 * It resolves the way every other call in this file resolves, because the two
 * errors are not the same size. Declining to hunt `hunter2` leaves it masked
 * at its field by the key-name pass, which needs no heuristic to be right, and
 * exposed only where it is echoed loose in free text. Hunting `getUserById2`
 * cuts that identifier out of every line of a transcript that is replayed to
 * the model, and nothing puts it back. One is a gap; the other is damage.
 *
 * See the limitations note at the top of redactPersistedEvent -- this is one
 * of the two shapes recorded there as knowingly not covered.
 */
const WORD_WITH_TRAILING_DIGITS_RE = /^[A-Za-z]+[0-9]{1,3}$/;
/**
 * A path or timezone spelled out of words: `America/New_York`, `src/main`.
 *
 * Slash-separated word segments are how a transcript writes paths, and a
 * credential does not look like this. Base64 is not caught by it: its segments
 * are not words.
 */
const WORD_PATH_RE = /^[A-Za-z][A-Za-z_]*(\/[A-Za-z][A-Za-z_]*)+$/;
const BOOLEANISH = new Set([
  "true", "false", "yes", "no", "on", "off", "none", "null", "nil",
  "enabled", "disabled", "auto", "default", "debug", "info", "warn", "error",
]);

/**
 * Whether an all-letters value collides with prose. All of them do.
 *
 * `main`, `MAIN` and `Main` are one word in three casings and collide
 * identically, so exempting only the lowercase spelling exempted the wrong
 * third of them -- a `BRANCH_TOKEN=Staging` still cut "Staging" out of every
 * line that mentioned the environment.
 *
 * The obvious next step was to keep an exemption for internally-mixed casing,
 * on the theory that a generated token switches case mid-word (`XkjQmzPl`) and
 * vocabulary does not. That theory is false, and expensively so: `GitHub`,
 * `OpenAI`, `iPhone`, `macOS`, and every camelCase identifier a transcript is
 * full of switch case mid-word too. Under a name like `PROJECT_TOKEN` the
 * exemption's absence would have cut "GitHub" out of every sentence that used
 * it.
 *
 * So casing is not consulted at all. A run of nothing but letters, below the
 * length at which vocabulary runs out, is prose -- full stop. What is given up
 * is a generated all-alphabetic token of fewer than 16 characters, and it is
 * not given up to nothing: it stays masked by key name wherever it is a field,
 * which is the pass that does not need to guess. Only the blind substring hunt
 * declines it, and that hunt is the one whose mistakes cannot be undone.
 */
export function isDistinctiveSecret(secret: string): boolean {
  // Below this, a value cannot carry enough entropy to be worth the collision
  // risk no matter what it looks like.
  if (secret.length < 4) return false;
  const lower = secret.toLowerCase();
  if (BOOLEANISH.has(lower)) return false;
  if (ORDINARY_NUMBER_RE.test(secret)) return false;
  // A short run of letters written as a word is a word ("main", "Staging",
  // "REMOTE"). Past a certain length it stops being one -- a 16-character
  // alphabetic string is a token, not vocabulary.
  if (secret.length < 16 && ORDINARY_WORD_RE.test(secret)) return false;
  // A word with digits on the end is an identifier far more often than it is a
  // credential, and the two are indistinguishable. See the note on the
  // constant for why this resolves towards leaving prose alone.
  if (secret.length < 16 && WORD_WITH_TRAILING_DIGITS_RE.test(secret)) return false;
  // `America/New_York`, `src/main`: a path written in words, at any length.
  if (WORD_PATH_RE.test(secret)) return false;
  // `Node20.0.0-rc.1+OpenSSL3`, `Python3.12RC1+NumPy2`: a toolchain string is
  // long and punctuated enough to look distinctive by every measure above,
  // and cutting it takes the build out of every command that mentions it. A
  // var named RUNTIME_TOKEN really does get set to one of these.
  if (looksLikeVersionString(secret)) return false;
  return true;
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  runtimeSecrets: readonly string[],
  key?: string,
): unknown {
  if (key && isSensitiveKey(key) && value !== null && value !== undefined && value !== "") {
    return "<redacted>";
  }
  if (typeof value === "string") {
    let text = redactSecrets(value).text;
    for (const secret of runtimeSecrets) {
      if (isDistinctiveSecret(secret)) text = text.split(secret).join("<redacted>");
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, runtimeSecrets));
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "<redacted:cyclic>";
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactValue(childValue, seen, runtimeSecrets, childKey);
  }
  seen.delete(value);
  return out;
}

/**
 * Redact any persisted event before it reaches NATS, the event database, or
 * the transcript archive. Event shape is preserved so existing UI cards keep
 * rendering, while sensitive-key fields, known secret formats, and exact
 * runtime credentials are replaced.
 *
 * ── Known limitations, which are not the whole list ─────────────────────────
 *
 * Two shapes are knowingly NOT caught in free text, and calling them out here
 * is the point: they are deliberate choices, not oversights, and a reader who
 * assumes otherwise will build on a guarantee that was never made.
 *
 * They are examples, not an inventory. Every round of review on this code has
 * turned up another ordinary string that a heuristic mistook for a key, and
 * the honest reading is that the list below is where the search had got to,
 * not where it ends. Treat free text as unredacted and do not echo
 * credentials into it; that is the only guarantee available here.
 *
 *  1. A short, purely alphabetic secret (`DB_PASSWORD=XkjQmzPl`). The field is
 *     masked by the key-name pass, but `auth failed XkjQmzPl` written loose in
 *     a log line or tool output is not.
 *  2. A short secret that is a word with digits on the end (`hunter2`). Same:
 *     the field is masked, a free-text echo of it is not.
 *
 * Both survive free text because the only rules that would catch them also
 * catch ordinary prose -- `GitHub` and `macOS` for the first, `getUserById2`
 * and `retry3` for the second. This pass is a blind substring replace over
 * payloads that are REPLAYED TO THE MODEL, so a false positive does not mask a
 * secret; it deletes text from a conversation, and the agent resumes without
 * it. A missed secret in free text is bounded and recoverable by rotating the
 * credential. A corrupted transcript is neither.
 *
 * What closes these properly is not a better heuristic. It is not echoing
 * credentials into free text in the first place -- the key-name pass is exact
 * wherever a value sits in a field, and that is where secrets should stay.
 */
export function redactPersistedEvent(
  evt: Record<string, unknown>,
  runtimeSecrets: readonly string[] = [],
): Record<string, unknown> {
  return redactValue(evt, new WeakSet<object>(), runtimeSecrets) as Record<string, unknown>;
}

/** Backwards-compatible name retained for existing callers and tests. */
export const redactToolEvent = redactPersistedEvent;

export function redactCheckpointState<T>(
  state: T,
  runtimeSecrets: readonly string[] = [],
): T {
  return redactValue(state, new WeakSet<object>(), runtimeSecrets) as T;
}
