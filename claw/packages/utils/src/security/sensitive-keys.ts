// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The key-name half of redaction. redactSecrets() catches credentials by their
// *shape* (ak-..., a JWT, 64 hex chars); this catches them by the name of the
// field they sit in, which is the only thing that works for a value with no
// distinguishing form -- `userPassword: "hunter2"` looks like ordinary text.
//
// Lives here rather than in api/ or brain/ because both sides redact the same
// payloads: brain's redactPersistedEvent() masks an agent-loop event on the way
// to NATS, and api's redactPublicJson() masks the same event again on the way
// out over SSE. Two copies of a security control drift, and a sensitive name
// added to one of them leaves the other quietly leaking.

/**
 * Credential words that are sensitive on their own, wherever they appear in a
 * key name. Plurals are listed explicitly rather than matched by a suffix rule
 * because `tokens` must NOT be here: `input_tokens` / `prompt_tokens` /
 * `max_tokens` are usage counters that the UI renders.
 */
const SENSITIVE_WORDS = new Set([
  "token",
  "secret",
  "secrets",
  "password",
  "passwords",
  "authorization",
  // The whole auth family, as words rather than as a list of header names.
  // `x-auth`, `x-auth-key`, `authentication-info` and
  // `proxy-authentication-info` are all credential-bearing and none of them
  // was caught by naming `authorization` alone -- which is the failure mode a
  // fixed list has, and the reason this file matches by word.
  //
  // Splitting by word is what makes this safe to state so broadly: `oauth`,
  // `author`, `authors`, `authored` and `authenticated` are each a single
  // word and none of them is `auth`, so none of them trips this.
  "auth",
  "auths",
  "authentication",
  "authenticate",
  "authorisation",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  // Spellings with no internal boundary to split on, so the pair rule below
  // cannot see them.
  "apikey",
  "apikeys",
  "accesskey",
  "secretkey",
  "privatekey",
  "platformkey",
  "virtualkey",
  // A personal access token is a credential whose name says "token" only in
  // expanded form; the spelling that reaches a config file is GITHUB_PAT.
  "pat",
  "pats",
  // A DSN is a connection string, and a connection string is a password with
  // a hostname attached.
  "dsn",
  "connectionstring",
]);

/**
 * Adjacent word pairs that are sensitive together but harmless apart -- `key`
 * alone matches `keyboard_layout` and every `foreign_key`, so it is only
 * sensitive when qualified.
 */
const SENSITIVE_PAIRS = new Set([
  "api key",
  "access key",
  "secret key",
  "private key",
  "platform key",
  "virtual key",
  "signing key",
  "encryption key",
  // An SSH key is the private half often enough that the qualified pair is
  // worth treating as sensitive; `key` alone stays too broad to use.
  "ssh key",
  // A database URL carries its own credentials inline
  // (postgres://user:password@host/db), so the URL *is* the secret. `url`
  // alone is not: most of them are endpoints.
  "database url",
  "db url",
  "database uri",
  "db uri",
  "connection string",
]);

/**
 * Whole keys that carry an entire environment block. Matched against the full
 * normalized key rather than word-by-word so that `env` stays narrow: an
 * `environment` field of prose, or an `env_count`, is not a credential dump.
 */
const ENV_KEYS = new Set(["env", "user env", "session env", "runtime env"]);

/**
 * Whole keys that contain a sensitive word but are counters, not credentials.
 * `tokenUsage` is the checkpoint field carrying input/output token counts and
 * appears in every agent_done payload; redacting it would blank the usage
 * numbers the UI reports.
 */
const COUNTER_KEYS = new Set(["token usage", "token count", "token limit", "token len"]);

/**
 * Split a key into lowercase words across camelCase, snake_case, kebab-case and
 * dotted paths, so that one word list covers every spelling a JSON payload
 * might use. `OPENAI_API_KEY`, `openaiApiKey` and `x-api-key` all become
 * `["openai"?, "api", "key"]`.
 *
 * The two-step camel split is what makes acronyms work: the first pass breaks
 * `apiKey`, the second breaks the `APIKey` run into `API` + `Key` rather than
 * leaving one opaque token.
 */
function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Whether a value stored under `key` must be masked before it leaves the
 * process.
 *
 * Matching is by word, not substring: `accessToken` and `apiKeyId` are
 * credentials, while `tokenizer` and `brokenLink` merely contain the letters.
 * The predicate errs towards redacting -- a masked field that turned out to be
 * harmless is a cosmetic bug, a leaked one is not -- so anything genuinely safe
 * that trips it belongs in {@link COUNTER_KEYS} with a note on why.
 */
export function isSensitiveKey(key: string): boolean {
  const words = splitWords(key);
  if (words.length === 0) return false;
  const normalized = words.join(" ");
  if (COUNTER_KEYS.has(normalized)) return false;
  if (ENV_KEYS.has(normalized)) return true;
  for (let i = 0; i < words.length; i += 1) {
    if (SENSITIVE_WORDS.has(words[i]!)) return true;
    if (i + 1 < words.length && SENSITIVE_PAIRS.has(`${words[i]} ${words[i + 1]}`)) return true;
  }
  return false;
}
