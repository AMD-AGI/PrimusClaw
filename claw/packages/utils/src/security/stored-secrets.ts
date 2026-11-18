// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { redactSecrets, type RedactResult } from "./redact-secrets.js";
import { isSensitiveKey } from "./sensitive-keys.js";

// The copy of a conversation the API writes to its database -- session events, conversation turns, an assistant's
// inbound messages -- is masked here before it is written. Not the copy a model reads in the turn it arrives in: the
// caller masks only what goes into the INSERT and keeps the original for everything else it does with the message.
//
// `redactSecrets` is the base: vendor token shapes (`ghp_`, `github_pat_`, documented `sk-` prefixes, JWT, ...),
// `Bearer` tokens of 20 or more characters, URLs with a password in them. A stored row is read back as history, so the
// same care about prose applies as in a transcript, and what is added on top is only what has a shape no prose has:
//
//  - a SaFE API key (`ak-` and one unbroken run of 24 or more letters and digits, with the dash-separated tail some
//    keys carry, consumed whole so no part of the key is left behind);
//  - a `Bearer` token shorter than 20 characters that has a digit in it (`Bearer abc123def456`), which "Bearer token"
//    and "Bearer authentication" never do;
//  - an armored private key, from its BEGIN line to its END line (to the end of the text when the END is missing);
//  - a value written after a credential's name (`password=`, `"api_key": "..."`, `token: ...`), with the same idea as
//    the log pass (`redactLogSecrets`) but a name list narrowed to credentials and values that read as code left alone:
//    `password = getPassword()`, `password: string`, `token = config.token`, `password=${DB_PASSWORD}`, `password:
//    required` are not credentials, and a quoted value with a space in it is a sentence (`"password": "Enter your
//    password"`), not a password.
//
// What is not caught, stated plainly: a credential in prose with no name in front of it and no vendor shape
// ("the password is hunter2"), and an all-letter value written YAML-style (`password: hunter`), which reads the same
// as a type annotation. Both are the price of not rewriting ordinary conversation.

const SAFE_API_KEY_RE = /\bak-[A-Za-z0-9]{24,}(?:-[A-Za-z0-9]{1,16})*\b/g;
const SHORT_BEARER_RE = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}/gi;
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN ([A-Z0-9 ]{0,32})PRIVATE KEY-----/g;

/**
 * A credential's name, then `=`, `:=` or `:`, then its value: quoted (to the closing quote on the same line, at most 512
 * characters) or unquoted (a run with no space, quote, separator or bracket in it). The name starts where a name can (not inside
 * another one) and may be quoted itself (`"password": ...`). `secret` alone is not a name here: in configuration it names an
 * object (`secret: my-secret`), and only a prefixed one (`client_secret`, `AWS_SECRET`) is taken.
 */
const NAMED_VALUE_RE = /(?<![A-Za-z0-9_.-])(["']?)((?:[A-Za-z0-9]+[_.-])*(?:password|passwd|passphrase|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret[_-]?key)|(?:[A-Za-z0-9]+[_.-])+secret)\1(\s*)(:=|=|:)(\s*)(?:(["'])([^"'\r\n]{0,512}?)\6|([^\s"'`,;&()[\]{}<>]{1,512}))/gi;

/** Values written after a credential's name that are not one: a switch, a placeholder, a mask. */
const NOT_A_VALUE_RE = /^(?:true|false|null|none|nil|undefined|enabled|disabled|yes|no|on|off|required|optional|\*+|x+|\.+|-+)$/i;
/** A reference to a value kept elsewhere: `${VAR}`, `$VAR`, `%VAR%`, `{{ .Values.x }}`, `<your-token>`. */
const REFERENCE_RE = /^(?:\$|%[A-Za-z_]|\{\{|<)/;
/** An identifier or a property path with no digit in it: what code assigns from (`getPassword`, `config.token`, `string`). */
const CODE_NAME_RE = /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)*$/;

function isNamedCredential(value: string, quoted: boolean, spaced: boolean, sep: string, next: string): boolean {
  if (!value || NOT_A_VALUE_RE.test(value) || REFERENCE_RE.test(value)) return false;
  if (value.includes("<redacted") || value.includes("[REDACTED]")) return false;
  if (/^[0-9]{1,5}$/.test(value)) return false;
  if (quoted) return !/\s/.test(value);
  // A call (`getPassword()`) or an index (`env["TOKEN"]`, `tokens[0]`).
  if (next === "(" || next === "[") return false;
  // `password=hunter` in an env file or a query string is a credential; `password = getPassword`, `password: string` are code.
  if (CODE_NAME_RE.test(value) && (spaced || sep !== "=")) return false;
  return true;
}

function maskPrivateKeys(text: string): { text: string; hits: number } {
  let out = "";
  let kept = 0;
  let hits = 0;
  PRIVATE_KEY_BEGIN_RE.lastIndex = 0;
  for (let m = PRIVATE_KEY_BEGIN_RE.exec(text); m; m = PRIVATE_KEY_BEGIN_RE.exec(text)) {
    const endLine = `-----END ${m[1]}PRIVATE KEY-----`;
    const at = text.indexOf(endLine, m.index + m[0].length);
    hits += 1;
    out += `${text.slice(kept, m.index)}<redacted private key>`;
    if (at < 0) return { text: out, hits };
    kept = at + endLine.length;
    PRIVATE_KEY_BEGIN_RE.lastIndex = kept;
  }
  return { text: out + text.slice(kept), hits };
}

function maskNamedValues(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(NAMED_VALUE_RE, (whole, q1: string, name: string, pre: string, sep: string, post: string,
    q2: string | undefined, quotedValue: string | undefined, bareValue: string | undefined, offset: number) => {
    const quoted = q2 !== undefined;
    const value = quoted ? (quotedValue ?? "") : (bareValue ?? "");
    const next = text[offset + whole.length] ?? "";
    if (!isNamedCredential(value, quoted, pre.length > 0 || post.length > 0, sep, next)) return whole;
    hits += 1;
    return `${q1}${name}${q1}${pre}${sep}${post}${quoted ? `${q2}<redacted>${q2}` : "<redacted>"}`;
  });
  return { text: out, hits };
}

/** Mask credential-shaped content in one string that is about to be stored. */
export function redactStoredText(text: string): RedactResult {
  if (!text) return { text: "", hits: 0 };
  const base = redactSecrets(text);
  let hits = base.hits;
  let out = base.text.replace(SAFE_API_KEY_RE, () => {
    hits += 1;
    return "<redacted>";
  });
  out = out.replace(SHORT_BEARER_RE, (_, prefix: string) => {
    hits += 1;
    return `${prefix}<redacted>`;
  });
  const keys = maskPrivateKeys(out);
  const named = maskNamedValues(keys.text);
  return { text: named.text, hits: hits + keys.hits + named.hits };
}

/**
 * A deep copy of a JSON-compatible value with every string masked by `redactStoredText`, and the value under a field named like a
 * credential (`isSensitiveKey`, the same judgement brain's `redactPersistedEvent` makes) replaced when it is a non-empty string or
 * a container. Keys and every other value are kept as they are, so the fields a reader routes on (`type`, ids, sequence numbers,
 * counts) are unchanged, and an identifier field's string (`IDENTIFIER_KEY_RE`) is not masked. The input is not modified.
 */
export function redactStoredValue<T>(value: T): T {
  return walk(value) as T;
}

/**
 * A field that names a record rather than holding content: `id`, `message_id`, `tool_use_id`, `actionId`, `app_task_id`. Readers
 * match stored rows on these (a completion's `message_id`, a tool result's `tool_use_id`), and a caller may choose an id freely: an
 * A2A `messageId` can be a 64-hex idempotency key, which `redactSecrets` takes for a credential. Brain keeps `message_id` after its
 * own redaction for the same reason.
 */
const IDENTIFIER_KEY_RE = /^(?:id|[A-Za-z0-9_]*_id|[A-Za-z0-9]*[a-z0-9]Id)$/;
/** An identifier is one token: a value with whitespace in it, or a long one, is content and is masked as usual. */
const IDENTIFIER_VALUE_RE = /^[^\s]{1,256}$/;

function walk(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && IDENTIFIER_KEY_RE.test(key) && IDENTIFIER_VALUE_RE.test(value)) return value;
    return redactStoredText(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // A switch or a count under such a name (`{"token": false}`) keeps its type, an empty value has nothing to leak, and one
    // brain already masked stays as brain wrote it.
    const holds = (typeof child === "string" && child !== "" && child !== "[REDACTED]") || (!!child && typeof child === "object");
    out[key] = holds && isSensitiveKey(key, child) ? "<redacted>" : walk(child, key);
  }
  return out;
}
