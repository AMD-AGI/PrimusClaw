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
/**
 * A run of nothing but letters -- in any script, not just the Latin ASCII one.
 *
 * `\p{L}` rather than `A-Za-z`, with `\p{M}` alongside it so that a diacritic
 * written as a combining mark counts as part of its letter and a decomposed
 * `naïveté` reads the same as a precomposed one. Without that, this rule said
 * "purely alphabetic" and meant "purely English": `naïveté`, `façade`,
 * `développement` and `конфигурация` were all hunted, and a transcript in any
 * language but one lost words the ASCII spelling kept.
 *
 * Digits, separators and punctuation stay outside the class, so nothing that
 * was hunted before is exempted now beyond the letters themselves -- `abc-123`
 * and every vendor key format still fall through to the return below.
 */
const ORDINARY_WORD_RE = /^[\p{L}\p{M}]+$/u;
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
 *
 * The digit run is unbounded. It was capped at three for no reason anyone
 * wrote down, and the cap did the opposite of protecting anything: the longer
 * the run, the more the value reads as a year, a date or a counter rather than
 * a credential. `report2024`, `snapshot20240115` and `getUserById2024` are the
 * shapes a transcript is actually full of, and at `{1,3}` every one of them
 * was hunted while `hunter2` -- an actual password, and the reason this rule
 * exists -- was spared. A boundary that spares the password and cuts the
 * timestamp is exactly backwards.
 *
 * The justification first written here was that generated credentials do not
 * have this shape because they interleave their digits. That is not true, and
 * review produced the counterexample: `llm_api_key=XkjQmzPlVbNrTqWd20240903`
 * is a key that ends in a date, and it is indistinguishable by shape from
 * `snapshot20240903`. No digit boundary separates them, at three or at four or
 * anywhere else -- the two strings have the same shape because there is only
 * one shape.
 *
 * What separates them is not shape but provenance, which is why the answer is
 * `RuntimeSecrets` below rather than a different number here. A key handed to
 * the run as `llm_api_key` is hunted without this rule ever being consulted; a
 * value merely nominated out of an environment reaches this rule, and there
 * the tie is broken towards leaving the transcript intact. What is given up is
 * the free-text echo of a nominated value ending in digits -- the same thing
 * already given up for `hunter2`, and still masked wherever the value sits in
 * a field.
 */
const WORD_WITH_TRAILING_DIGITS_RE = /^[\p{L}\p{M}]+[0-9]+$/u;
/**
 * A path or timezone spelled out of words: `America/New_York`, `src/main`.
 *
 * Slash-separated word segments are how a transcript writes paths, and a
 * credential does not look like this. Base64 is not caught by it: its segments
 * are not words.
 *
 * The leading slash is optional because it was not, and that was a hole. The
 * pattern required the value to START with a letter, so `src/main` was spared
 * and `/workspace/project` -- the same path, written the way a shell actually
 * writes it -- was not. Absolute paths are the single most common thing in a
 * transcript this pass must not touch, and they were the one form of path it
 * could not see. The predicate below still requires a slash somewhere, so a
 * bare word does not reach this rule and change meaning.
 */
const WORD_PATH_RE = /^\/?[\p{L}][\p{L}\p{M}_]*(?:\/[\p{L}][\p{L}\p{M}_]*)*$/u;
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
 * Three rules were tried for telling a long word from a long token, and each
 * was defeated by ordinary English within a round of review:
 *
 *   - mixed-case means generated. `GitHub`, `macOS`, `iPhone`, and every
 *     camelCase identifier a transcript is full of.
 *   - sixteen letters is past what vocabulary reaches. `internationalization`
 *     is twenty, `characterization` is exactly sixteen.
 *   - a word is a third vowels and never stacks five consonants.
 *     `straightforwardly`, `straightforwardness`, `misunderstandings` and
 *     `strengthlessness` are none of those things and are all words.
 *   - letters are `A-Za-z`. Only in one language. `naïveté`, `façade`,
 *     `développement` and `конфигурация` are words too, and were hunted for
 *     the sole reason that they are not spelled in ASCII.
 *
 * The fourth attempt is to stop. A run of nothing but letters is never hunted,
 * at any length and in any casing, because every rule that separates the two
 * has been wrong and the failures all land on the destructive side: the value
 * being judged is blind-substring-replaced across payloads REPLAYED TO THE
 * MODEL, so a wrong answer does not mask a secret, it deletes a word from a
 * conversation the agent then resumes without.
 *
 * What is given up is real and is written down at {@link redactPersistedEvent}
 * as a known limitation: an all-alphabetic secret is not hunted in free text.
 * It is not given up to nothing. Such a value is still masked by key name
 * wherever it sits in a field, which is the pass that does not guess, and a
 * missed secret is bounded and fixed by rotating the credential. A hole in a
 * replayed transcript is fixed by nothing.
 *
 * An earlier version of this note claimed a fitted false-positive rate for a
 * shape heuristic. That number came from a corpus that was never checked in
 * and could not be reproduced from this repository, which is its own argument
 * against deciding anything this way.
 */
export function isDistinctiveSecret(secret: string): boolean {
  // Below this, a value cannot carry enough entropy to be worth the collision
  // risk no matter what it looks like.
  if (secret.length < 4) return false;
  const lower = secret.toLowerCase();
  if (BOOLEANISH.has(lower)) return false;
  if (ORDINARY_NUMBER_RE.test(secret)) return false;
  // Nothing but letters is never hunted, at any length, in any script. See
  // the note above this function for why the shape of a letter run is not a
  // question worth asking, and the note on the constant for why the letters
  // are Unicode ones.
  if (ORDINARY_WORD_RE.test(secret)) return false;
  // A word with digits on the end is an identifier far more often than it is a
  // credential, and the two are indistinguishable. See the note on the
  // constant for why this resolves towards leaving prose alone.
  if (WORD_WITH_TRAILING_DIGITS_RE.test(secret)) return false;
  // `America/New_York`, `src/main`, `/workspace/project`: a path written in
  // words, at any length. The slash test is what keeps a bare word out of the
  // pattern, which now tolerates a leading one.
  if (secret.includes("/") && WORD_PATH_RE.test(secret)) return false;
  // `Node20.0.0-rc.1+OpenSSL3`, `Python3.12RC1+NumPy2`: a toolchain string is
  // long and punctuated enough to look distinctive by every measure above,
  // and cutting it takes the build out of every command that mentions it. A
  // var named RUNTIME_TOKEN really does get set to one of these.
  if (looksLikeVersionString(secret)) return false;
  return true;
}

/**
 * The credentials a run holds, split by how much is actually known about them.
 *
 * This distinction is the whole reason isDistinctiveSecret has to guess. A
 * value in `certain` was handed to the run AS a credential -- the platform
 * key, the LLM API key, the internal token. There is no inference involved and
 * nothing to be wrong about. A value in `nominated` was picked out of an
 * environment because its NAME read like a credential or its VALUE looked like
 * one, and both of those are guesses that have been wrong in every round of
 * review this file has been through.
 *
 * Shape rules were being applied to both, which meant the only values the
 * process is certain about were being second-guessed by heuristics built for
 * the values it is not. `llm_api_key=XkjQmzPlVbNrTqWd20240903` is a real key
 * that happens to end in a date, and no shape rule can tell it from
 * `snapshot20240903` -- but nothing has to, because the run was told it is a
 * key. Certainty answers what shape cannot.
 */
export interface RuntimeSecrets {
  /** Handed to the run as credentials. Known, not inferred. */
  readonly certain: readonly string[];
  /** Picked out of an environment by name or by shape. Guesses. */
  readonly nominated: readonly string[];
}

/** Either form: a bare list is all-nominated, which is what callers passed before. */
export type RuntimeSecretsInput = readonly string[] | RuntimeSecrets;

function asRuntimeSecrets(input: RuntimeSecretsInput): RuntimeSecrets {
  return Array.isArray(input) ? { certain: [], nominated: input } : input as RuntimeSecrets;
}

/**
 * The floor under a credential the run was handed.
 *
 * Certainty removes the shape question but not the collision one: a blind
 * substring replace of a four-character value would still shred a transcript,
 * and a credential that short does not exist. Eight is the same floor
 * looksLikeCredentialValue uses to decide a value is worth considering at all,
 * so the two passes agree on what is too small to be a secret. The booleanish
 * guard stays for the degenerate case of an unset key defaulting to a word.
 */
function isHuntableCertainSecret(secret: string): boolean {
  return secret.length >= 8 && !BOOLEANISH.has(secret.toLowerCase());
}

/**
 * Every secret worth hunting, deduped, longest first.
 *
 * The order is the point. Replacing one secret rewrites the text the next one
 * is searched in, so a secret that is a PREFIX of another destroys the longer
 * match if it goes first: a platform key `Xk9$mzPl2vQr7Tn4` replaced ahead of
 * a `SERVICE_TOKEN` of `Xk9$mzPl2vQr7Tn4.sig9f3c2b1d4e5a` leaves
 * `<redacted>.sig9f3c2b1d4e5a` -- the signed half of a live credential, in the
 * clear, put there by the pass that exists to remove it. Longest first cannot
 * make that mistake: the longer secret has already claimed its occurrences by
 * the time the shorter one is looked for, and the shorter one still catches
 * every place it appears on its own.
 *
 * Sorted rather than relied upon to arrive in a useful order, because the
 * order it arrives in is the order two env blocks happened to be iterated in.
 * Ties break on the string itself so the same set of secrets always produces
 * the same output whichever way it was assembled.
 *
 * Which gate each candidate passes still depends on where it came from --
 * certainty is a fact about provenance and survives being put in one list. A
 * value named in both is treated as certain: the run was told it is a key, and
 * a shape rule has nothing to add to that.
 */
function huntableSecrets(secrets: RuntimeSecrets): string[] {
  const byOrigin = new Map<string, boolean>();
  for (const secret of secrets.certain) {
    if (!byOrigin.has(secret)) byOrigin.set(secret, true);
  }
  for (const secret of secrets.nominated) {
    if (!byOrigin.has(secret)) byOrigin.set(secret, false);
  }
  const hunt: string[] = [];
  for (const [secret, certain] of byOrigin) {
    if (certain ? isHuntableCertainSecret(secret) : isDistinctiveSecret(secret)) {
      hunt.push(secret);
    }
  }
  return hunt.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function redactString(text: string, secrets: RuntimeSecrets): string {
  let out = text;
  // Exact matches first, shape scan second. The shape pass rewrites what it
  // recognizes, so running it first can consume PART of a known secret --
  // `ghp_...:second-half` loses its vendor-shaped prefix to redactSecrets and
  // then no longer contains the string the exact pass is looking for, leaving
  // the other half in the clear. An exact match cannot make that mistake, and
  // shape-scanning what is left over afterwards is still correct.
  //
  // The two halves of that argument are the same one: whatever runs first
  // rewrites what the rest can still find. It applies between the exact
  // secrets as well, which is what the ordering in huntableSecrets is for.
  for (const secret of huntableSecrets(secrets)) {
    out = out.split(secret).join("<redacted>");
  }
  return redactSecrets(out).text;
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  runtimeSecrets: RuntimeSecrets,
  key?: string,
): unknown {
  if (key && isSensitiveKey(key) && value !== null && value !== undefined && value !== "") {
    return "<redacted>";
  }
  if (typeof value === "string") return redactString(value, runtimeSecrets);
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
 *  1. A purely alphabetic secret, at ANY length and in ANY script
 *     (`DB_PASSWORD=XkjQmzPl`, or a 32-character generated one). The field is masked by the key-name pass,
 *     but `auth failed XkjQmzPl` written loose in a log line or tool output is
 *     not.
 *  2. A secret that is a word with digits on the end (`hunter2`). Same: the
 *     field is masked, a free-text echo of it is not.
 *
 * Both survive free text because the only rules that would catch them also
 * catch ordinary prose -- `GitHub` and `macOS` for the first, `getUserById2`
 * and `retry3` for the second. The first limitation used to be qualified as
 * "short", on the strength of a rule that judged longer runs by shape. Three
 * such rules were tried and English broke all three (see the note on
 * isDistinctiveSecret), so the qualifier is gone and the limitation is now
 * simply the whole class. This pass is a blind substring replace over
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
  runtimeSecrets: RuntimeSecretsInput = [],
): Record<string, unknown> {
  return redactValue(
    evt, new WeakSet<object>(), asRuntimeSecrets(runtimeSecrets),
  ) as Record<string, unknown>;
}

/** Backwards-compatible name retained for existing callers and tests. */
export const redactToolEvent = redactPersistedEvent;

/**
 * Mask a value on its way OUT of this process -- into NATS, the event
 * database, the transcript archive, the SSE stream, or the ExecuteResult that
 * becomes a downstream node's prompt.
 *
 * Previously called redactCheckpointState, which is how it came to be applied
 * to the checkpoint: a name that says "checkpoint" makes redacting one look
 * like the intended use. It never was. A checkpoint is the conversation a
 * resumed run replays to the model, and mutating it deletes content the agent
 * then no longer has. Seven call sites reference it. Six are genuine egress;
 * the seventh hands it to the checkpoint writer as an explicit parameter, used
 * on the v3 format only -- the codec cannot import it at all, which is what
 * keeps that the deliberate exception rather than a habit (see
 * checkpoint-codec.ts).
 *
 * `runtimeSecrets` is required rather than defaulted. An optional parameter is
 * one a caller can omit and still typecheck, and `redactEgressPayload(x)` with
 * no secrets does no exact-value replacement at all while looking like it did.
 */
export function redactEgressPayload<T>(
  value: T,
  runtimeSecrets: RuntimeSecretsInput,
): T {
  return redactValue(value, new WeakSet<object>(), asRuntimeSecrets(runtimeSecrets)) as T;
}
