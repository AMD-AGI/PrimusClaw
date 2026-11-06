// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { isSensitiveKey } from "./sensitive-keys.js";

// Secret redaction utilities used across Brain / API before any out-bound
// write. redactSecrets() overwrites secret-shaped literals with
// "<redacted>"; scanForSecretLeak() is a non-mutating probe over the same
// literal catalogue used by workspace archive flows. Both are string-only
// with no Brain / API dependency so they can run in any layer.

const TOKEN_LITERAL_RE =
  /(CLAW_INTERNAL_TOKEN[\s=:"']*)([A-Fa-f0-9]{32,})/g;
const BEARER_RE = /(?:authorization\s*:\s*)?(Bearer\s+)([A-Za-z0-9._\-]{20,})/gi;
const X_API_KEY_RE = /(x-api-key\s*[:=]\s*["']?)([^\s"',;]{20,})/gi;
// Aggregated raw hex 32-byte token (the internal RPC token shape). Matched
// alone catches stray tokens that lost their CLAW_INTERNAL_TOKEN prefix
// during transformation (e.g. logged "token=<hex>").
const HEX_TOKEN_32B_RE = /\b[A-Fa-f0-9]{64}\b/g;
// Vendor token shapes. These are matched by what the value looks like, not by
// the name of the field holding it, which is the only thing that works when a
// credential is stored somewhere unremarkable -- `CONFIG=ghp_...`, a token
// pasted into a comment, a key echoed by a tool. The name-based passes cannot
// see any of those.
//
// Every alternative is anchored on a LEADING \b, and that is not decoration.
// Without it each prefix matched mid-identifier and took the rest of the word
// with it: `sk-` inside `task-management-system` redacted to `ta<redacted>`,
// `hf_` inside `myhf_...` to `my<redacted>`. This pass runs over transcripts
// that are replayed to the model, so a partial match does not mask a secret,
// it silently rewrites the conversation -- the exact failure mode the
// name-based pass was narrowed to stop.
//
// `sk-` is the hard one, and two rounds of generic heuristics failed on it.
// The prefix is two letters, so it occurs inside ordinary hyphenated
// identifiers, and every property tried as a stand-in for "this is a key" has
// an ordinary identifier that satisfies it:
//
//   requirement                          ordinary string that satisfies it
//   a 16+ unbroken run                   sk-internationalization-settings
//   32+ chars with a digit and a capital sk-HTTP2-client-configuration-for-Production
//
// That is not a coincidence to be patched around. Entropy tests on a mixed
// alphabet all have a boundary, and hyphenated English is on the wrong side of
// every boundary low enough to catch a real key.
//
// So `sk-` is matched by its DOCUMENTED prefixes and their documented minimum
// lengths instead of by one generic rule. `sk-ant-api03-` is Anthropic's,
// `sk-proj-` and `sk-svcacct-` are OpenAI's project and service-account forms,
// `sk-live-`/`sk-test-` are the hyphenated Stripe-style spellings. The bare
// legacy form (`sk-` + 48 base64url, no internal separators) is admitted only
// as one unbroken 32+ alphanumeric run containing a digit, which no English
// word reaches -- the longest are around 30 letters and have no digits.
//
// The cost, stated plainly: an undocumented or future `sk-` format whose body
// is separator-dense and under 32 characters is not caught by shape. It is
// still caught by name -- these arrive in `llm_api_key` and in `*_API_KEY`
// vars, which both passes already cover -- and this is the direction to err
// in, because a false positive here is not a masked secret but a hole cut in
// a transcript that gets replayed to the model.
//
// The other rule, and the one that had nothing to do with `sk-`: what the
// pattern CONSUMES must be the whole token, separators included. Writing a
// requirement as the final consumed segment made the match stop at the last
// long run, so `sk-ant-api03-<93>-<6>AA` redacted to `<redacted>-BBBBBBAA` and
// published the key's last eight characters. Partial redaction is the worst
// outcome available: it mangles the text AND it leaks.
const VENDOR_TOKEN_RE = new RegExp([
  "\\bgh[pousr]_[A-Za-z0-9]{16,}",                      // GitHub classic
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",                    // GitHub fine-grained
  "\\bxox[baprs]-[A-Za-z0-9-]{10,}",                    // Slack
  // sk-: documented vendor prefixes with their documented minimum bodies.
  "\\bsk-ant-api03-[A-Za-z0-9_-]{80,}",                 // Anthropic
  "\\bsk-ant-[A-Za-z0-9_-]{40,}",                       // Anthropic, older
  "\\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}",   // OpenAI, base64url
  // Stripe and its siblings are underscore-delimited and their bodies are
  // one unbroken base62 run. Nothing in this class carries word separators,
  // so the body may not either. A dash-delimited `sk-live-...` was a guess at
  // a format no vendor publishes, and it read `sk-live-payment-processing-
  // configuration` as a key; it is gone, left to the legacy rule and the name
  // pass rather than approximated.
  "\\b[rs]k_(?:live|test)_[A-Za-z0-9]{24,}",           // Stripe
  "\\bsk-(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}",        // legacy bare form
  "\\bhf_[A-Za-z0-9]{20,}",                             // Hugging Face
  "\\bAKIA[0-9A-Z]{16}",                                // AWS access key id
  "\\bglpat-[A-Za-z0-9_-]{16,}",                        // GitLab
  "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", // JWT
].join("|"), "g");
// A URL carrying inline credentials is a password with a hostname attached.
// Only the credential half is replaced so the endpoint stays legible -- knowing
// which host a run talked to is usually the point of the log line.
//
// The userinfo half is `user:password`, and BOTH halves are optional in the
// grammar. `redis://:s3cr3t@host` -- a password with no username -- is the
// spelling Redis and a few managed brokers hand out by default, and requiring
// a username meant that one was not redacted at all. The username is `*` now
// rather than `+`; the colon and the password still have to be there, so a
// bare `scheme://host` is untouched.
//
// The scheme begins where a run of scheme characters begins (the lookbehind), not at
// every letter inside it. Without that, a long run of letters with no `://` after it
// is rescanned from each of its starting positions, which is quadratic: a single line
// of 64 KB of letters took 16 seconds and blocked the event loop for all of them.
//
// The one other place a scheme may begin is straight after a line's own `+` or `-`. Those are
// scheme characters, and a patch marks every added and removed line with one, so a line that BEGINS
// with a URL (`+postgres://app:pw@db/x`, `-git+https://u:pw@host/r.git`) would otherwise read its
// marker as the front of the scheme and go unmasked. The allowance is one position per line (the
// `m` flag makes `^` a line start), so it adds at most one more start per line and stays linear.
const URL_CREDENTIALS_RE = /(?:(?<![a-zA-Z0-9+.-])|(?<=^[+-]))([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/gm;

/**
 * Whether a discrete configuration VALUE looks like a credential on its own.
 *
 * Separate from the passes above, and deliberately not a pass over free text.
 * The regexes above scan prose, so they can only afford shapes with a literal
 * vendor prefix. This one is handed a single env-var value -- one whole field,
 * with a boundary at each end -- and can therefore ask a question prose cannot
 * be asked: does this entire string look like nothing but a password?
 *
 * It exists because the name-based collection in Brain's runtimeSecrets() has
 * a hole it cannot close by itself. `BUILD_CONFIG=P@ssw0rd` is a live
 * credential under a name that reads as configuration, so no name rule sees
 * it, and it carries no vendor prefix, so no shape regex sees it either.
 *
 * The conditions are narrow on purpose, and each one is a value some earlier
 * version of this rule destroyed.
 *
 * A credential candidate must be spelled entirely in the alphabet a password
 * uses, `[A-Za-z0-9._~+@!$%^&*-]`. That single condition rejects most of what
 * goes wrong, because ordinary configuration is not spelled that way: a path
 * or URL has `/`, a command has spaces, and a flag or an assignment has `=`.
 * `-DFoo=Bar1` is a real cmake value and reads as a credential to any rule
 * built on "has a symbol and mixes case"; here the `=` disqualifies it before
 * anything else is asked. `#Aa12Bb34` goes the same way on the `#`.
 *
 * It must then carry a symbol from `[@!$%^&*+~]` specifically -- the ones that
 * appear in passwords and essentially nowhere in configuration. `-`, `.` and
 * `_` are excluded from that set even though they are allowed in the value,
 * because they are how ordinary config spells everything: `Qwen3-8B`,
 * `v1.2.3`, `some.host.internal`.
 *
 * A leading `-` or `+` is flag syntax, never a credential.
 *
 * It must not parse as a familiar structured format. Two get through every
 * character-class rule, because they are built from exactly the characters a
 * password is built from: an email address (`User1@example.com`) and a
 * word-symbol-word pattern (`Foo1.*Bar2`, `Abc1+Def2`, the contents of a
 * REGEX or GLOB variable). Both are recognised by structure rather than by
 * charset -- a domain-shaped tail after an `@`, or symbol-delimited segments
 * that are every one of them a plain word with at most a trailing digit. A
 * real credential fails the second test almost by definition, because its
 * digits fall inside the segments rather than after them: `P@ssw0rd` splits
 * into `P` and `ssw0rd`, and neither is a word with a digit stuck on the end.
 *
 * All three of lower, upper and digit must be present, and at least six
 * DISTINCT characters. The distinct-character floor is the entropy half, and
 * it is what stops a short repeating pattern from qualifying on the strength
 * of one symbol. A real credential that fails it is not left in the clear --
 * it is left to the name-based pass, which is the correct place for a value
 * with no shape.
 *
 * What it deliberately does NOT catch: an all-lowercase value like `hunter2`
 * under an unremarkable name. Nothing distinguishes that from ordinary config,
 * and a rule loose enough to catch it is the rule that deleted model paths out
 * of the transcripts they appeared in. It stays covered by its name (`DB_PASSWORD`) and by
 * the key-name mask, which is where a value with no shape has to be caught.
 *
 * The asymmetry driving all of this: a missed credential here is still caught
 * by name and still masked at the key; a false positive is blind-substituted
 * out of a transcript that gets replayed to the model, and cannot be undone.
 */
const CREDENTIAL_CHARSET_RE = /^[A-Za-z0-9._~+@!$%^&*-]+$/;
const CREDENTIAL_SYMBOL_RE = /[@!$%^&*+~]/;
/** `name@host.tld` -- an address, whatever variable it was found in. */
const EMAIL_SHAPED_RE = /@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/**
 * A plain word, optionally with digits stuck on the end: `Foo`, `Bar2`.
 *
 * The vowel is what carries the weight. Without it this also swallows
 * `Xk9$mzPl2` -- a password with the same skeleton as `Abc1+Def2` -- and the
 * two are separable only by whether the letter runs read as words at all.
 * Three letters is the floor for the same reason: at two, `aB12+cD34+eF56`
 * reads as a word between versions instead of as the password it is.
 */
const WORD_SEGMENT_RE = /^(?=[A-Za-z]*[AEIOUYaeiouy])[A-Za-z]{3,}[0-9]{0,3}$/;

/** An acronym, with or without a version on it: `SSL`, `AVX2`, `SHA256`. */
const ACRONYM_SEGMENT_RE = /^[A-Z]{2,}[0-9]{0,3}$/;

/**
 * The filler a version or architecture string puts between its words.
 *
 * `x86_64+AVX2` breaks into `x86`, `64`, `AVX2`, and only the last of those
 * is a word by any reading -- which is why a rule asking every segment to be
 * a word rejected the whole string and called an arch triple a password.
 * A bare number, and a short letter run with a version stuck on it (`x86`,
 * `gcc11`), carry nothing on their own, so they are allowed to sit between
 * the words without deciding anything -- the decision is left to the rule
 * that at least one segment must be a real word or acronym.
 *
 * A number may carry a release tag: `12rc1`, `13t`, `0b1`, `2post1`. The tag
 * is a fixed vocabulary rather than any short letter run, and it is matched
 * without regard to case, because PEP 440 normalises `RC`, `Rc` and `rc` to
 * the same thing and all three get typed. It may also stand on its own --
 * SemVer spells the same release `20.0.0-rc.1`, where `rc` is a segment by
 * itself, below the word floor and carrying no digits to make it a version.
 *
 * Naming the tags is what keeps the floor where round 4 put it. Admitting any
 * two-letter segment here would let `aB12+cD34+eF56` back in; admitting `rc`
 * by name does not, because a value still has to contain a real word or
 * acronym somewhere before any of this filler counts for anything.
 */
const RELEASE_TAG = "(?:alpha|beta|pre(?:view)?|post|rev|dev|rc|[abct]|r)";
const VERSION_SEGMENT_RE = new RegExp(
  `^(?:[0-9]{1,4}(?:${RELEASE_TAG}[0-9]{0,3})?|${RELEASE_TAG}|[A-Za-z]{1,4}[0-9]{1,3})$`,
  "i",
);

/**
 * Whether every symbol-delimited piece reads as prose or as a version.
 *
 * `Foo1.*Bar2` and `Abc1+Def2` are patterns, `x86_64+AVX2` and
 * `Node18.20+OpenSSL3` are toolchain strings, and what says so in every case
 * is that taking the symbols out leaves nothing but words, acronyms and
 * numbers. A credential's segments are none of those -- its digits and case
 * changes fall inside them, as in `Xk9$mzPl2` or `Tr0ub4dor&3x`.
 *
 * At least one segment has to be a real word or acronym. Numbers and
 * letter-number pairs are filler, and a value made only of filler --
 * `aB12+cD34+eF56` -- is not a version string, it is a password.
 */
function isProseOrVersion(value: string): boolean {
  const segments = value.split(/[^A-Za-z0-9]+/).filter((seg) => seg.length > 0);
  if (segments.length < 2) return false;
  const isWord = (seg: string) => WORD_SEGMENT_RE.test(seg) || ACRONYM_SEGMENT_RE.test(seg);
  if (!segments.some(isWord)) return false;
  return segments.every((seg) => isWord(seg) || VERSION_SEGMENT_RE.test(seg));
}
/**
 * Whether a value reads as a version or toolchain string.
 *
 * Narrower than the prose exemption above, and deliberately so: `abc-123` is
 * a word beside a number and satisfies that one, but it is also exactly what
 * a short credential looks like, and it is pinned as distinctive elsewhere.
 * What a real version has that `abc-123` does not is digits welded onto a
 * word -- `Node20`, `Python3`, `OpenSSL3`, `AVX2` -- or a release tag naming
 * itself. Requiring one of those keeps the two apart.
 *
 * Exported because the brain filters runtime secrets through a second gate of
 * its own, and a build string has to survive both. One definition here beats
 * two that drift.
 */
export function looksLikeVersionString(value: string): boolean {
  if (!isProseOrVersion(value)) return false;
  const segments = value.split(/[^A-Za-z0-9]+/).filter((seg) => seg.length > 0);
  const versioned = new RegExp(`^(?:[A-Za-z]{2,}[0-9]{1,3}|${RELEASE_TAG}[0-9]{0,3})$`, "i");
  return segments.some((seg) => versioned.test(seg));
}

export function looksLikeCredentialValue(value: string): boolean {
  if (value.length < 8 || value.length > 128) return false;
  if (!CREDENTIAL_CHARSET_RE.test(value)) return false;
  if (!CREDENTIAL_SYMBOL_RE.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("+")) return false;
  if (EMAIL_SHAPED_RE.test(value)) return false;
  if (isProseOrVersion(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  return new Set(value).size >= 6;
}

/**
 * A URI, split far enough to ask whether it carries a credential.
 *
 * Deliberately not `new URL()`: that accepts far more than this needs to
 * admit, normalizes what it parses, and throws on the relative forms a config
 * file is full of. The groups are scheme, authority, path, query, fragment.
 *
 * The path alternative must start with `/`, and that is not cosmetic. Written
 * as a bare `[^?#]*` it overlapped the authority's `[^/?#]*` -- every
 * character either could match, both could match, and a non-matching input
 * made the engine try every split between them. That is quadratic on the
 * length of the input, on a predicate that runs over environment values, and
 * CodeQL is right to call it a denial of service (js/polynomial-redos).
 * Requiring the leading `/` makes the split unambiguous: exactly one place in
 * any input can begin the path.
 *
 * The fragment is CAPTURED rather than skipped. Discarding it read
 * `https://example.invalid/cb#access_token=<token>` as credential-free and
 * left a real token standing in the transcript -- an implicit-flow callback
 * puts the credential after the `#` precisely because that half does not
 * travel to the server, and there is nothing about it that is less of a
 * secret for that.
 */
const URI_RE =
  /^([A-Za-z][A-Za-z0-9+.\-]*):\/\/([^/?#]*)((?:\/[^?#]*)?)(?:\?([^#]*))?(?:#(.*))?$/;

/** `/etc/hosts`, `./build`, `../shared`, `~/.ssh/config`. */
const FS_PATH_RE = /^(?:~|\.{1,2})?\/[^\s]*$/;

/**
 * An unbroken alphanumeric run mixing all three cases of character.
 *
 * looksLikeCredentialValue requires a symbol, which is right for the value of
 * a whole variable and wrong for one component of a path or a query: the
 * separator that would have been the symbol is what split the component off in
 * the first place. `/etc/creds/Xk9mzPl2vQr7TnA4` is a secret filed under a
 * directory, and nothing but this rule sees it.
 *
 * Twelve characters and all three cases, because that is what an ordinary file
 * name is not: `id_ed25519` and `qwen3-8b` have separators, `README` has no
 * digits, `Qwen3-8B` is short. What it costs is the exemption for a path with
 * a long unpunctuated CamelCase-plus-digits component -- such a path stays
 * collected, which is the behaviour that was already there, and this is the
 * side to be wrong on for a rule that decides what NOT to redact.
 */
const OPAQUE_TOKEN_RE =
  /^(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{12,}$/;

function carriesCredential(part: string): boolean {
  return part.length > 0
    && (looksLikeCredentialValue(part) || OPAQUE_TOKEN_RE.test(part));
}

function segmentCarriesCredential(path: string): boolean {
  return path.split("/").some(carriesCredential);
}

/** `%2F` back to `/`, and the raw text when the escaping is malformed. */
function percentDecode(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Enough for a callback URL inside a callback URL, and not enough to recurse. */
const MAX_LOCATOR_DEPTH = 3;

/**
 * Whether one `name=value` pair of a query string or fragment is a credential.
 *
 * The value is percent-decoded first, and that is the whole of the fix for the
 * case this got wrong: `redirect_uri=https%3A%2F%2Fapp.example%2Fcb` is a URL
 * an OAuth client is required to send, and encoded it satisfies every clause
 * of `looksLikeCredentialValue` -- the upper-case letters are the hex digits
 * of `%3A` and `%2F`, and the symbols are the percent signs. It was read as a
 * credential because of its escaping, which is the one property of a string
 * that says nothing at all about whether it is secret.
 *
 * Decoded, a value that is itself a location is judged as one, recursively --
 * a nested callback URL is not a key however deeply it is nested. The
 * recursion terminates because each level takes a strict substring: the inner
 * value begins after a `?` or `#` the outer one had.
 */
function paramCarriesCredential(rawValue: string, depth: number): boolean {
  const value = percentDecode(rawValue);
  if (!value) return false;
  if (depth < MAX_LOCATOR_DEPTH && (URI_RE.test(value) || FS_PATH_RE.test(value))) {
    return !locatorIsCredentialFree(value, depth + 1);
  }
  return carriesCredential(value);
}

/**
 * Whether a query string or fragment carries a credential.
 *
 * Both halves are `name=value&...` in practice -- the implicit OAuth flow
 * returns `access_token=...` in the fragment for the same reason a form posts
 * it in the query -- so both are read the same way. A bare component with no
 * `=` is tested as a value in its own right, which is what a fragment that is
 * just an opaque token looks like.
 */
function paramsCarryCredential(params: string, depth: number): boolean {
  for (const param of params.split(/[&;]/)) {
    if (!param) continue;
    const eq = param.indexOf("=");
    if (eq === -1) {
      if (paramCarriesCredential(param, depth)) return true;
      continue;
    }
    if (isSensitiveKey(param.slice(0, eq))) return true;
    if (paramCarriesCredential(param.slice(eq + 1), depth)) return true;
  }
  return false;
}


/**
 * Whether a value is a location rather than a credential: an endpoint URL or a
 * filesystem path that carries no secret of its own.
 *
 * This exists because of what a credential-shaped NAME does to a harmless
 * value. `TOKEN_ENDPOINT=https://example.invalid/oauth/token` and
 * `SSH_KEY_PATH=/home/user/.ssh/id_ed25519` are both named exactly the way an
 * OAuth client and an SSH config are supposed to name them, and neither value
 * is a secret -- the endpoint is public and the path is where the key lives,
 * not the key. The name pass collected both, and once collected a value is
 * blind-substring-replaced across payloads REPLAYED TO THE MODEL, so every
 * mention of the endpoint and every command naming that path lost the string
 * out of the middle of it. Masking the field would have been free; deleting
 * the path from the transcript is what the agent then resumes without.
 *
 * What is checked, and why each: userinfo in the authority
 * (`postgres://user:pass@host/db`) means the URL IS the credential -- that is
 * the case `database url` is in the pair list for, and it must keep being
 * collected. A query parameter named like a credential, or holding a
 * credential-shaped value, is the same leak with a different spelling -- as is
 * one in the FRAGMENT, which is where the OAuth implicit flow puts the token
 * it returns. And any
 * documented vendor shape anywhere in the string means part of it is a key
 * however the rest reads, so the whole value stays a secret.
 *
 * The predicate answers only "is this worth hunting by substring". The field
 * itself is still masked by name wherever it appears as a field, which is the
 * pass that does not guess.
 */
export function isCredentialFreeLocator(value: string): boolean {
  return locatorIsCredentialFree(value, 0);
}

function locatorIsCredentialFree(value: string, depth: number): boolean {
  if (!value || /\s/.test(value)) return false;
  // A vendor-shaped token anywhere in it: part of this string is a key.
  if (redactSecrets(value).hits > 0) return false;
  const uri = URI_RE.exec(value);
  if (uri) {
    const [, , authority = "", path = "", query, fragment] = uri;
    // `user:pass@host` -- the URL carries its own credentials inline.
    if (authority.includes("@")) return false;
    if (query && paramsCarryCredential(query, depth)) return false;
    if (fragment && paramsCarryCredential(fragment, depth)) return false;
    return !segmentCarriesCredential(percentDecode(path));
  }
  if (FS_PATH_RE.test(value)) return !segmentCarriesCredential(value);
  return false;
}

export interface RedactResult {
  text: string;
  hits: number;
}

/**
 * Replace secret-shaped literals in `text` with `<redacted>`.
 *
 * Pass `extraSecrets` (e.g. the run's internal_token) to also redact the exact
 * value — useful when the caller knows its own credential and wants to defend
 * against unconventional formats the regex catalogue missed.
 */
export function redactSecrets(text: string, extraSecrets: string[] = []): RedactResult {
  if (!text) return { text: "", hits: 0 };
  let hits = 0;
  let out = text;
  out = out.replace(TOKEN_LITERAL_RE, (_, prefix) => {
    hits += 1;
    return `${prefix}<redacted>`;
  });
  out = out.replace(BEARER_RE, (_, prefix) => {
    hits += 1;
    return `${prefix}<redacted>`;
  });
  out = out.replace(X_API_KEY_RE, (_, prefix) => {
    hits += 1;
    return `${prefix}<redacted>`;
  });
  out = out.replace(HEX_TOKEN_32B_RE, () => {
    hits += 1;
    return "<redacted>";
  });
  out = out.replace(VENDOR_TOKEN_RE, () => {
    hits += 1;
    return "<redacted>";
  });
  out = out.replace(URL_CREDENTIALS_RE, (_, scheme) => {
    hits += 1;
    return `${scheme}<redacted>@`;
  });
  for (const secret of extraSecrets) {
    if (!secret || secret.length < 16) continue;
    // Use string-replace with global semantics; avoid regex special-char issues.
    let from = 0;
    while ((from = out.indexOf(secret, from)) !== -1) {
      hits += 1;
      out = out.slice(0, from) + "<redacted>" + out.slice(from + secret.length);
      from += "<redacted>".length;
    }
  }
  return { text: out, hits };
}

/**
 * Where a value written after a credential's name starts in a log line: `PASSWORD=`, `"api_key": "`, `Authorization: `, also
 * inside a JSON string (`\\"token\\": \\"`), and a command line's option (`--password=...`, `--db-password ...`). The name
 * starts where a name can (not inside another one; after a JSON string's `\\n`, `\\r` or `\\t`; after one or two dashes that start
 * an option) and is judged by `isSensitiveKey`; an auth scheme (`Bearer`, `Basic`, `Token`) after it is kept and the value after the
 * scheme is masked, quoted or not. Where the value ends is `NamedValueEnds`'s to find: a quoted value runs to its
 * closing quote, spaces and all, so `"password": "correct horse battery staple"` goes whole.
 */
const NAMED_VALUE_START_RE = /(?:(?<![A-Za-z0-9_.\\-])|(?<=\\[nrt])|(?<=(?:^|[^A-Za-z0-9_.\\-])-{1,2}))(\\["']|["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]*[:=][ \t]*|(?<=(?:^|[^A-Za-z0-9_.\\-])-{1,2}[A-Za-z_][A-Za-z0-9_.-]{0,63})[ \t]+)((?:[Bb]asic|[Bb]earer|[Tt]oken)\s+)?(\\["']|["']?)/g;
/**
 * What an unquoted value is checked at: a line's end, a quote, an escape, and the separators and brackets that may end it. Not a
 * space: `a b` is one value.
 */
const UNQUOTED_VALUE_STOP = /[\r\n"'\\,;&()[\]{}<>]/;
/** After `,`, `;` or `&`: another `name=` or `name: ` starts there, so the separator ended the value (`?token=x&page=2`). */
const NEXT_PAIR_RE = /[ \t]*[A-Za-z_][A-Za-z0-9_.-]{0,63}[ \t]*(?:=|:(?=[\s"']))/y;
const OPENER_OF: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const CLOSER_OF: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const noBrackets = (): Record<string, number> => ({ ")": 0, "]": 0, "}": 0, ">": 0 });
/**
 * What may stand before a credential's name on its line for the line to be an assignment, as `env`, `printenv`, `set` and a
 * shell script print one: indentation, and a shell's or a Dockerfile's keyword; or all of that right after a string opens, as
 * the first line of a log inside a JSON answer does (`{"logs":"export DB_PASSWORD=...`, `["DB_PASSWORD=...`, `msg: "...`). Such a
 * value has no structure after `=`: it is masked to its line's end, or to the closing quote of the string it is in, whatever
 * characters it holds. Group 1 is the quote that opened the string on this line, if one did.
 */
const ASSIGNMENT_LINE_PREFIX_RE = /^(?:(?:[^\r\n]*?[:,[({=])?[ \t]*(\\?["']))?[ \t]*(?:(?:export|declare(?:[ \t]+-[A-Za-z]+)*|typeset(?:[ \t]+-[A-Za-z]+)*|readonly|local|set|ENV)[ \t]+)?$/;

/** The line a named value is on, as `LineTracker` saw it up to the value's name. */
interface LineContext {
  /** The name starts its line (after indentation or a shell keyword): the value runs to the line's end. */
  assignment: boolean;
  /**
   * The quote whose closing ends the line's value as well (an assignment's): `"` for a line that began at a JSON string's `\n` or
   * `\r`, or the quote that opened a string before the name on the line (`\"` inside a JSON string). Empty when none.
   */
  closeQuote: string;
  /** Per closing bracket, how many of its openers before the name on this line are still open. */
  open: Record<string, number>;
}
const NO_LINE: LineContext = { assignment: false, closeQuote: "", open: noBrackets() };

/**
 * Where each line of a text starts, and the brackets opened on it, read forward once: `seek(i)` for `i` that never decreases.
 * A line starts after a real line end or a JSON string's `\n` / `\r`; a backslash before any other character escapes it.
 */
class LineTracker {
  private at = 0;
  private start = 0;
  private escapedStart = false;
  private open = noBrackets();

  constructor(private readonly text: string) {}

  /** Move to `i`; brackets passed count only when `brackets` is set (not inside a value just masked). */
  private advance(i: number, brackets: boolean): void {
    const t = this.text;
    for (; this.at < i; this.at += 1) {
      const c = t[this.at];
      if (c === "\n" || c === "\r") {
        this.start = this.at + 1;
        this.escapedStart = false;
        this.open = noBrackets();
      } else if (c === "\\") {
        const next = t[this.at + 1];
        this.at += 1;
        if (next === "n" || next === "r") {
          this.start = this.at + 1;
          this.escapedStart = true;
          this.open = noBrackets();
        }
      } else if (brackets && CLOSER_OF[c]) {
        this.open[CLOSER_OF[c]] += 1;
      } else if (brackets && OPENER_OF[c] && this.open[c] > 0) {
        this.open[c] -= 1;
      }
    }
  }

  /** The line of a name that starts at `i`, quoted by `quote` (empty when it is not). */
  context(i: number, quote: string): LineContext {
    this.advance(i, true);
    const prefix = i - this.start <= 64 ? this.text.slice(this.start, i) : null;
    const assignment = quote === "" && prefix !== null ? ASSIGNMENT_LINE_PREFIX_RE.exec(prefix) : null;
    // A string opened on this line closes first; else, on a JSON string's line, that string's own closing quote.
    const opened = assignment?.[1] ?? "";
    return {
      assignment: assignment !== null,
      closeQuote: opened ? (this.escapedStart && opened === '"' ? '\\"' : opened) : this.escapedStart ? '"' : "",
      open: { ...this.open },
    };
  }

  /** Move past a masked value without counting its brackets. */
  skip(i: number): void {
    this.advance(i, false);
  }
}

/**
 * The first index at or after `from` where `at(i)` holds (the text's length when none does), for `from` that never decreases:
 * an answer found from an earlier `from` stands for every later one up to it, so the whole text is scanned at most once.
 */
function forwardFinder(length: number, at: (i: number) => boolean): (from: number) => number {
  let scannedFrom = -1;
  let found = -1;
  return (from) => {
    if (from >= scannedFrom && from <= found) return found;
    let i = from;
    while (i < length && !at(i)) i += 1;
    scannedFrom = from;
    found = i;
    return i;
  };
}

/**
 * Where each named value in one text ends, asked in the order the values start. A quoted value (`"`, `'`, or `\"`, `\'` inside a
 * JSON string) ends at its closing quote before the line's real end: a quote escaped inside it is part of it (an even run of
 * backslashes before the quote at the top level; one more than a multiple of four inside a JSON string, where the value's own
 * escaped quote is `\\\"`). Without a closing quote it ends at the line's end, where a JSON string's `\n` counts as one.
 *
 * An unquoted value on an assignment line (`DB_PASSWORD=...`, `export DB_PASSWORD=...`) runs to the line's end, and on a line
 * inside a JSON string to the string's closing quote if that comes first: an `env` line has no structure after `=`, and a
 * generated password holds `&`, `;`, `)` and `>` as often as letters. Elsewhere it ends at the line's end, a quote or an escape,
 * and at a separator or a bracket only where the text around it makes it one: `,`, `;` and `&` only when another `name=` follows
 * (`?token=x&page=2`, `{password=x, user=y}`), a closing bracket only when its opener is before the name on the same line and not
 * inside the value (`connect(password=x)`, but `password=<x>` whole). Trailing spaces are not the value's. Each question is
 * answered from scans that only move forward, so a log of any shape costs its length.
 */
class NamedValueEnds {
  private readonly realLineEnd: (from: number) => number;
  private readonly lineEnd: (from: number) => number;
  private readonly unquotedStop: (from: number) => number;
  private readonly closers = new Map<string, (from: number) => number>();

  constructor(private readonly text: string) {
    const t = text;
    const escapedBreak = (i: number) => t[i] === "\\" && (t[i + 1] === "n" || t[i + 1] === "r");
    this.realLineEnd = forwardFinder(t.length, (i) => t[i] === "\n" || t[i] === "\r");
    this.lineEnd = forwardFinder(t.length, (i) => t[i] === "\n" || t[i] === "\r" || escapedBreak(i));
    this.unquotedStop = forwardFinder(t.length, (i) => UNQUOTED_VALUE_STOP.test(t[i]));
  }

  /** The closing quote of this kind at or after `from`: the index its delimiter starts at. */
  private closer(quote: string): (from: number) => number {
    let find = this.closers.get(quote);
    if (!find) {
      const t = this.text;
      const mark = quote[quote.length - 1];
      const nested = quote.length === 2;
      find = forwardFinder(t.length, (i) => {
        if (t[i] !== mark) return false;
        let b = 0;
        while (i - b - 1 >= 0 && t[i - b - 1] === "\\") b += 1;
        return nested ? b % 4 === 1 : b % 2 === 0;
      });
      this.closers.set(quote, find);
    }
    return find;
  }

  /** Where the closing `quote` at or after `from` starts (its backslash, for an escaped one). */
  private closingAt(from: number, quote: string): number {
    const mark = this.closer(quote)(from);
    return quote.length === 2 && mark < this.text.length ? mark - 1 : mark;
  }

  /** The end (exclusive) of the value starting at `from`, opened by `quote` (empty, or a quote with its escape), on `line`. */
  end(from: number, quote: string, line: LineContext): number {
    const quoted = /["']$/.test(quote);
    if (quoted) {
      const mark = this.closer(quote)(from);
      const close = quote.length === 2 ? mark - 1 : mark;
      if (mark < this.text.length && close >= from && mark < this.realLineEnd(from)) return close;
    }
    let end: number;
    if (quoted) end = this.lineEnd(from);
    else if (line.assignment) end = line.closeQuote ? Math.min(this.lineEnd(from), this.closingAt(from, line.closeQuote)) : this.lineEnd(from);
    else end = this.unquotedEnd(from, line);
    while (end > from && /\s/.test(this.text[end - 1])) end -= 1;
    return end;
  }

  /** An unquoted value off an assignment line: to the first quote, escape or line end, or a separator or bracket that ends it. */
  private unquotedEnd(from: number, line: LineContext): number {
    const t = this.text;
    const limit = this.lineEnd(from);
    const inValue = noBrackets();
    for (let i = from; ;) {
      const e = this.unquotedStop(i);
      if (e >= limit) return limit;
      const c = t[e];
      i = e + 1;
      if (CLOSER_OF[c]) {
        inValue[CLOSER_OF[c]] += 1;
      } else if (OPENER_OF[c]) {
        if (inValue[c] > 0) inValue[c] -= 1;
        else if (line.open[c] > 0) return e;
      } else if (c === "," || c === ";" || c === "&") {
        NEXT_PAIR_RE.lastIndex = e + 1;
        if (NEXT_PAIR_RE.test(t)) return e;
      } else {
        return e;
      }
    }
  }
}

/** Values a credential's name is followed by that are not a credential: a switch, a placeholder, a mask. */
const NOT_A_VALUE_RE = /^(?:true|false|null|none|nil|undefined|enabled|disabled|yes|no|on|off|required|optional|\*+|x+|\.+)$/i;
/**
 * An armored private key's BEGIN or END line, with its label (`RSA `, `EC `, `OPENSSH `, `ENCRYPTED `, or none) and, for an
 * OpenPGP key, ` BLOCK`.
 */
const PRIVATE_KEY_LINE_RE = /-----(BEGIN|END) ([A-Z0-9 ]{0,32})PRIVATE KEY( BLOCK)?-----/g;
/** A line's last word when it can be a key's base64 (or a path made of the same characters), and what stands before it. */
const KEY_TAIL_RE = /(?:^|[\s"'`:=,([{])([A-Za-z0-9+/]+={0,2})$/;
/** The base64 run that ends right where an END line starts, on the same line. */
const KEY_TOUCHING_END_RE = /[A-Za-z0-9+/]+={0,2}$/;
/** An armored key's own header lines (an encrypted PEM's, an OpenPGP key's). */
const PEM_HEADER_RE = /^\s*(?:Proc-Type|DEK-Info|Comment|Version|Hash):/;
/** A body line far from the END line counts as key material only if its base64 word is this long (a PEM line is 64). */
const KEY_WORD_MIN = 16;

/**
 * Where the masking of a key whose BEGIN line is not in the text (a log read from its tail) starts, for an END line at `endAt`
 * with nothing to keep masked before `floor`. It walks back from the END line over the lines that hold the key: lines that end in
 * a base64 word (any word for the first line above the END line, which may be a key's short last line; further up, a line that
 * is nothing else, or one whose word has KEY_WORD_MIN characters, so a log prefix such as a timestamp before each line is
 * allowed), the key's header lines, and blank lines between them. Lines are real lines or a JSON string's `\n` / `\r` ones. The
 * masking starts at the base64 word of the highest such line, so what stands before it on that line (`{"logs": "`, a timestamp)
 * is kept. When no line above the END line is key material, it starts at `floor`: what is kept before an END line is never a
 * key's body.
 */
function orphanKeyStart(text: string, endAt: number, floor: number): number {
  /** Where the line that ends at `end` starts, and where the line before it ends (-1 when this line starts at `floor`). */
  const lineStartOf = (end: number): { start: number; prev: number } => {
    for (let i = end; i > floor; i -= 1) {
      const c = text[i - 1];
      if (c === "\n" || c === "\r") return { start: i, prev: i - 1 };
      if ((c === "n" || c === "r") && i - 2 >= floor && text[i - 2] === "\\") return { start: i, prev: i - 2 };
    }
    return { start: floor, prev: -1 };
  };
  let { start, prev } = lineStartOf(endAt);
  let from = -1;
  const touching = KEY_TOUCHING_END_RE.exec(text.slice(start, endAt));
  if (touching) from = start + touching.index;
  let nearest = true;
  while (prev >= 0) {
    const end = prev;
    ({ start, prev } = lineStartOf(end));
    const line = text.slice(start, end).trimEnd();
    if (!line) continue;
    if (PEM_HEADER_RE.test(line)) {
      from = start;
      nearest = false;
      continue;
    }
    const m = KEY_TAIL_RE.exec(line);
    if (!m) break;
    const word = m[1];
    if (!nearest && word.length < KEY_WORD_MIN && line.trimStart() !== word) break;
    from = start + m.index + m[0].length - word.length;
    nearest = false;
  }
  return from < 0 ? floor : from;
}

/**
 * Armored private keys, each to its END line; their lines may be real line ends or a JSON string's `\n`. One without its END line
 * (a log cut inside it) is masked to the end of the text; one without its BEGIN line (a log read from its tail) from where its
 * body starts (`orphanKeyStart`). Each line is searched past the previous key's end, so the text is read once.
 */
function maskPrivateKeys(text: string): { text: string; hits: number } {
  let out = "";
  let kept = 0;
  let hits = 0;
  PRIVATE_KEY_LINE_RE.lastIndex = 0;
  for (let m = PRIVATE_KEY_LINE_RE.exec(text); m; m = PRIVATE_KEY_LINE_RE.exec(text)) {
    const [line, kind, label, block = ""] = m;
    hits += 1;
    if (kind === "BEGIN") {
      const endLine = `-----END ${label}PRIVATE KEY${block}-----`;
      const at = text.indexOf(endLine, m.index + line.length);
      out += `${text.slice(kept, m.index)}<redacted private key>`;
      if (at < 0) return { text: out, hits };
      kept = at + endLine.length;
    } else {
      out += `${text.slice(kept, orphanKeyStart(text, m.index, kept))}<redacted private key>`;
      kept = m.index + line.length;
    }
    PRIVATE_KEY_LINE_RE.lastIndex = kept;
  }
  return { text: out + text.slice(kept), hits };
}

/** Space in a spec dump: real, or a JSON string's escaped line ends and tabs. */
const SP = String.raw`(?:\s|\\[nrt])*`;
/**
 * A Kubernetes container's environment variable as a spec dump prints it, `{"name": "DB_PASSWORD", "value": "..."}` (also inside a
 * JSON string), and `- name: DB_PASSWORD` with `value: ...` on the next line: the credential's name is a value here, not a key,
 * so the named-value pass does not see it.
 */
const ENV_PAIR_JSON_RE = new RegExp(String.raw`(\\?")name\1${SP}:${SP}\1([A-Za-z_][A-Za-z0-9_.-]{0,63})\1${SP},${SP}\1value\1${SP}:${SP}(\1)`, "g");
const ENV_PAIR_YAML_RE = /(?:^|\n|\r|\\n|\\r)[ \t]*(?:-[ \t]+)?name:[ \t]*(\\?["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1[ \t]*(\r?\n|(?:\\r)?\\n)[ \t]*value:[ \t]*(\\?["']?)/g;

/** The values of Kubernetes environment variables whose name is a credential's (`ENV_PAIR_*_RE`). */
function maskEnvPairs(text: string): { text: string; hits: number } {
  type Pair = { from: number; quote: string; line: LineContext };
  const pairs: Pair[] = [];
  ENV_PAIR_JSON_RE.lastIndex = 0;
  for (let m = ENV_PAIR_JSON_RE.exec(text); m; m = ENV_PAIR_JSON_RE.exec(text)) {
    if (isSensitiveKey(m[2])) pairs.push({ from: m.index + m[0].length, quote: m[3], line: NO_LINE });
  }
  ENV_PAIR_YAML_RE.lastIndex = 0;
  for (let m = ENV_PAIR_YAML_RE.exec(text); m; m = ENV_PAIR_YAML_RE.exec(text)) {
    if (isSensitiveKey(m[2])) {
      pairs.push({ from: m.index + m[0].length, quote: m[4], line: { assignment: true, closeQuote: m[3].startsWith("\\") ? '"' : "", open: noBrackets() } });
    }
  }
  if (!pairs.length) return { text, hits: 0 };
  pairs.sort((a, b) => a.from - b.from);
  const ends = new NamedValueEnds(text);
  let out = "";
  let kept = 0;
  let hits = 0;
  for (const p of pairs) {
    if (p.from < kept) continue;
    const end = ends.end(p.from, p.quote, p.line);
    const value = text.slice(p.from, end);
    if (!value || NOT_A_VALUE_RE.test(value)) continue;
    hits += 1;
    out += `${text.slice(kept, p.from)}<redacted>`;
    kept = end;
  }
  return { text: out + text.slice(kept), hits };
}

/**
 * `redactSecrets`, and then what a log carries that a transcript pass does not mask: a value written after a credential's name
 * (`DB_PASSWORD=...`, `"api_key": "..."`), a Kubernetes environment variable named like a credential, and an armored private key.
 * For text a log read returned, before a model sees it (an assistant's router reads logs with `ExecuteRequest.log_reads`): a job
 * prints its environment and its configuration, and names are the one thing such a value carries. Not for transcripts: there
 * `token = getToken()` and `password: required` are code and prose, and the name pass is the one `redactSecrets` keeps out of free
 * text on purpose.
 */
export function redactLogSecrets(text: string, extraSecrets: string[] = []): RedactResult {
  const first = redactSecrets(text, extraSecrets);
  const keys = maskPrivateKeys(first.text);
  let hits = first.hits + keys.hits;
  const out = keys.text;
  const ends = new NamedValueEnds(out);
  const lines = new LineTracker(out);
  let masked = "";
  let kept = 0;
  NAMED_VALUE_START_RE.lastIndex = 0;
  for (let m = NAMED_VALUE_START_RE.exec(out); m; m = NAMED_VALUE_START_RE.exec(out)) {
    const [start, q1, name, sep, scheme = "", q2] = m;
    if (!isSensitiveKey(name)) continue;
    const from = m.index + start.length;
    // `"env": [...]`, `"auth": {...}`: a structure, whose own entries are judged by their own names.
    if (!q2 && !scheme && sep.includes(":") && (out[from] === "[" || out[from] === "{")) continue;
    const end = ends.end(from, q2, lines.context(m.index, q1));
    const value = out.slice(from, end);
    // Any value but a switch or a placeholder, however short: `password=abc` is a credential too.
    if (!value || NOT_A_VALUE_RE.test(value)) continue;
    hits += 1;
    masked += `${out.slice(kept, m.index)}${q1}${name}${q1}${sep}${scheme}${q2}<redacted>`;
    kept = end;
    lines.skip(end);
    NAMED_VALUE_START_RE.lastIndex = end;
  }
  const pairs = maskEnvPairs(masked + out.slice(kept));
  return { text: pairs.text, hits: hits + pairs.hits };
}

/**
 * Redact `text`, then truncate it to `max` characters for logging.
 *
 * The order is the point. Truncating first can cut a secret in half, leaving a
 * fragment that no longer matches the catalogue and so survives redaction —
 * still plenty to leak. Redacting first means a secret straddling the cut is
 * replaced before the cut happens.
 *
 * Only a bounded window is scanned, since callers pass values as large as a
 * whole file read. The window is `max` plus a margin wider than any secret
 * shape here, so a secret starting before the cut is still matched whole.
 */
export function safePreview(text: string, max: number): string {
  if (!text) return "";
  const MARGIN = 512;
  const window = text.length > max + MARGIN ? text.slice(0, max + MARGIN) : text;
  const redacted = redactSecrets(window).text;
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

export interface ScanHit {
  category:
    | "token_literal" | "bearer" | "x_api_key" | "raw_hex_32" | "explicit_secret"
    | "vendor_token" | "url_credentials";
  excerpt: string;
}

/**
 * Non-destructive scan. Returns first hit or null. Used by Brain archive to
 * detect secret leaks BEFORE uploading a tarball; on hit we short-circuit
 * the upload and bubble up failure_reason='secret_leak_detected'.
 *
 * `knownSecrets` should include the current run's internal_token so a stray
 * occurrence of that exact value (regardless of context) is caught.
 */
export function scanForSecretLeak(text: string, knownSecrets: string[] = []): ScanHit | null {
  if (!text) return null;
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 16) continue;
    const idx = text.indexOf(secret);
    if (idx !== -1) {
      return {
        category: "explicit_secret",
        excerpt: text.slice(Math.max(0, idx - 16), idx + secret.length + 16),
      };
    }
  }
  const checks: Array<[RegExp, ScanHit["category"]]> = [
    [TOKEN_LITERAL_RE, "token_literal"],
    [BEARER_RE, "bearer"],
    [X_API_KEY_RE, "x_api_key"],
    // The shape catalogue, scanned for the same reason it is redacted: these
    // are the credentials stored somewhere unremarkable, which is exactly the
    // kind that reaches an archive tarball. This file's own header promises
    // the two functions work off one catalogue, and a shape added only to the
    // redactor quietly breaks that -- the upload would be waved through
    // carrying a token the redactor two layers up would have masked.
    [VENDOR_TOKEN_RE, "vendor_token"],
    [URL_CREDENTIALS_RE, "url_credentials"],
    // raw 32B hex is noisy; only match alongside an explicit token name to
    // avoid false-positives on legitimate hash dumps. Skip in scan.
  ];
  for (const [re, category] of checks) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) {
      const idx = m.index ?? 0;
      return {
        category,
        excerpt: text.slice(Math.max(0, idx - 16), idx + (m[0]?.length ?? 0) + 16),
      };
    }
  }
  return null;
}
