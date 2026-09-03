// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

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
// `sk-` additionally needs more than a boundary, because its charset includes
// the hyphen and so a boundary alone still swallows any hyphenated phrase
// beginning with those two letters. A real OpenAI/Anthropic key ends in one
// long unbroken run (`sk-ant-api03-<48 chars>`, `sk-proj-<48 chars>`), while a
// phrase is short segments all the way down, so the run is what distinguishes
// them: `sk-learn-is-a-typo` has no segment near key length and is left alone.
const VENDOR_TOKEN_RE = new RegExp([
  "\\bgh[pousr]_[A-Za-z0-9]{16,}",                      // GitHub classic
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",                    // GitHub fine-grained
  "\\bxox[baprs]-[A-Za-z0-9-]{10,}",                    // Slack
  "\\bsk-(?:[A-Za-z0-9_]{1,20}-)*[A-Za-z0-9_]{16,}",    // OpenAI / Anthropic style
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
const URL_CREDENTIALS_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/g;

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
 * The conditions are narrow on purpose, and each one is a value the previous
 * rule destroyed. Rejecting anything containing a slash or whitespace keeps
 * `/models/qwen3-8b` and `sed -n '140,340p' ...` out. Requiring a character
 * outside `[A-Za-z0-9._-]` keeps `Qwen3-8B`, every version string and every
 * dotted hostname out -- those are the shapes ordinary configuration takes.
 * Requiring all three of lower, upper and digit alongside it is what is left
 * of "password" once the guessable parts are gone.
 *
 * What it deliberately does NOT catch: an all-lowercase value like `hunter2`
 * under an unremarkable name. Nothing distinguishes that from ordinary config,
 * and a rule loose enough to catch it is the rule that deleted MODEL_PATH out
 * of a thousand transcripts. It stays covered by its name (`DB_PASSWORD`) and
 * by the key-name mask, which is where a value with no shape has to be caught.
 */
const STRONG_SYMBOL_RE = /[^A-Za-z0-9._-]/;
export function looksLikeCredentialValue(value: string): boolean {
  if (value.length < 8 || value.length > 128) return false;
  if (/[\s/]/.test(value)) return false;
  if (!STRONG_SYMBOL_RE.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
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
