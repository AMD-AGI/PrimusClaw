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
  // The spellings a real config file uses. `password` written out in full is
  // the exception rather than the rule once a vendor is involved: MySQL reads
  // MYSQL_PWD, OpenSSH prompts for a passphrase, and /etc/shadow's ancestor
  // named the field `passwd`. Each is a password under another name and none
  // of them contains the word.
  //
  // `pwd` is NOT here. It is in QUALIFIED_WORDS below: bare `PWD` is the shell
  // working directory, which every container sets, and treating it as a
  // credential collected `/workspace/project` as a secret and cut it out of
  // every transcript that named a path. That is the bug this whole pass
  // exists to prevent, caused by the pass itself.
  "passwd",
  "passphrase",
  "passphrases",
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
  // Postgres spells its password variable as one run of letters, so there is
  // no boundary for splitWords to break on and no pair rule that can see it:
  // `PGPASSWORD` arrives as the single word `pgpassword`. `PGPASS` is the same
  // variable's shorter spelling. Only names that are genuinely written this
  // way belong here -- MySQL's `MYSQL_PWD` has an underscore and is caught as
  // `pwd` above, which is the general rule doing the work rather than a list.
  "pgpassword",
  "pgpass",
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
 * Words that are a credential only when something qualifies them, because
 * standing alone they name something else entirely.
 *
 * `pwd` is the case that forced this category to exist. `MYSQL_PWD`, `DB_PWD`
 * and `mysql_pwd_hash` are passwords; bare `PWD` is the shell's working
 * directory, set in every container that has ever run, and its value is an
 * absolute path. Reading that as a credential does not merely mask a field --
 * it puts the path on the substring-replacement list and deletes it from every
 * line of the transcript that mentions it.
 *
 * The rule is "not the whole key" rather than a list of permitted qualifiers,
 * so `DB_PWD` and a vendor prefix nobody has thought of yet are both covered
 * without anyone maintaining a set of prefixes. What it gives up is a field
 * named exactly `pwd` that really does hold a password; that value is still
 * caught by shape if it has one, and the alternative was corrupting every
 * transcript in the fleet.
 */
const QUALIFIED_WORDS = new Set(["pwd"]);

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
 * Heads that are the same word in the plural, and the singular they normalize
 * to before the pair rule below is consulted.
 *
 * Only the pair rule sees this. `keys` and `tokens` standing alone stay
 * non-sensitive, which is not an oversight in either direction: bare `key` is
 * already excluded because most keys are map keys and sort keys, and bare
 * `tokens` is the usage counter every agent_done payload carries. What was
 * missing is the qualified compound -- `API_KEYS` and `ACCESS_TOKENS` are as
 * much a credential as their singulars, and both slipped through collection
 * and header rejection alike because the singular was matched by a rule that
 * spelled the head out letter for letter.
 *
 * A map rather than a suffix rule: stripping a trailing `s` would turn
 * `address` into `addres` and `status` into `statu`, and would pluralize the
 * exclusion list by accident. Two entries, both written down.
 */
const PLURAL_HEADS = new Map([["keys", "key"], ["tokens", "token"]]);

/**
 * Qualifiers that make a PLURALIZED head sensitive.
 *
 * The `key` half is exactly {@link SENSITIVE_PAIRS}, which already says which
 * qualifiers turn a key into a credential; deriving it means a pair added
 * there is covered in both numbers rather than in one.
 *
 * The `token` half has to be written out, because in the singular `token` is
 * sensitive on its own and no pair was ever needed. The list is the qualifiers
 * that actually name a credential, and it is deliberately NOT every word that
 * can precede `tokens`: `input`, `output`, `prompt`, `completion`, `max`,
 * `cached`, `reasoning`, `total` and `remaining` are all usage counters, they
 * are all rendered by the UI, and masking them would blank the numbers a user
 * reads. Those are pinned as negatives in the tests.
 */
const SENSITIVE_PLURAL_PAIRS = new Set([
  ...[...SENSITIVE_PAIRS].filter((pair) => pair.endsWith(" key")),
  "api token",
  "access token",
  "auth token",
  "authorization token",
  "bearer token",
  "refresh token",
  "session token",
  "service token",
  "secret token",
  "private token",
  "id token",
  "identity token",
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
    // Qualified only: sensitive as part of a name, never as the whole of one.
    if (words.length > 1 && QUALIFIED_WORDS.has(words[i]!)) return true;
    if (i + 1 < words.length) {
      const next = words[i + 1]!;
      if (SENSITIVE_PAIRS.has(`${words[i]} ${next}`)) return true;
      // `API_KEYS`, `ACCESS_TOKENS`: the same compound in the plural. Only the
      // head is normalized, and only to a singular this file lists, so a
      // qualifier that means nothing here still means nothing pluralized.
      const singular = PLURAL_HEADS.get(next);
      if (singular && SENSITIVE_PLURAL_PAIRS.has(`${words[i]} ${singular}`)) return true;
    }
  }
  return false;
}
