// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The fields a security event may carry, each with the check its value must pass. Ids, names and hosts take no spaces;
 * categories take only listed values; values that look like credentials or like a `/link` code are dropped even when
 * they fit a shape. So message text, link codes, keys and tokens cannot reach the log through a security event.
 */
import { pyStrip } from "../text/py-text.js";
import { B_END, S } from "../redact/py-regex.js";
import { parseIpAddress } from "./ip-address.js";

/** A field's check: the value to log, or undefined when it must not be logged. */
export type FieldCheck = (value: unknown) => unknown;

const ID = /^[A-Za-z0-9][A-Za-z0-9:;@._=+/-]{0,255}$/u;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CORRELATION = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/u;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/u;
const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const HOST = /^(?=[^\n]{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/u;

// A /link code: 8 characters of the link-code alphabet, which people type in any case and with spaces or dashes inside.
// A string is refused when, with canonical GUIDs and Teams' fixed conversation-id suffixes taken out, a run of whole
// segments between separators adds up to 8 characters that upper-cased are a code. The price: a real 8-character
// segment made only of code letters ("deadbeef", "releases") is dropped too.
const LINK_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u;
const SEGMENTS = new RegExp(`(?:${S}|[_.:;@=+/-])+`, "u");
const GUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const TEAMS_SUFFIXES = new RegExp(`@(?:thread\\.(?:v2|tacv2|skype)|unq\\.gbl\\.spaces)${B_END}`, "giu");

// Credential shapes refused in any string field, even one that fits its shape (an id field handed a key by mistake).
const CREDENTIAL = new RegExp(
  [
    "eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}", // JWT
    "(?:ak|sk)-[A-Za-z0-9_-]{16,}", // platform / OpenAI-style API keys, glued to text too
    "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}", // GitHub tokens
    "(?:AKIA|ASIA)[A-Z0-9]{16}", // AWS access keys
    "xox[abposr]-[A-Za-z0-9-]{10,}", // Slack
    "SharedAccessKey=", // Service Bus / Azure connection strings
  ].join("|"),
  "iu",
);

/** Whether `value` holds a `/link` code, as printed, as typed or inside a longer value. */
export function holdsALinkCode(value: string): boolean {
  const segments = value
    .replace(GUIDS, " ")
    .replace(TEAMS_SUFFIXES, " ")
    .split(SEGMENTS)
    .filter((segment) => segment !== "");
  for (let start = 0; start < segments.length; start++) {
    let run = "";
    for (const segment of segments.slice(start)) {
      run += segment;
      if (run.length >= 8) {
        if (run.length === 8 && LINK_CODE.test(run.toUpperCase())) return true;
        break;
      }
    }
  }
  return false;
}

function refused(value: string): boolean {
  return CREDENTIAL.test(value) || holdsALinkCode(value);
}

function shaped(pattern: RegExp, lower = false): FieldCheck {
  return (raw) => {
    if (typeof raw !== "string") return undefined;
    const value = lower ? raw.toLowerCase() : raw;
    return pattern.test(value) && !refused(value) ? value : undefined;
  };
}

function oneOf(values: ReadonlySet<string>): FieldCheck {
  return (value) => (typeof value === "string" && values.has(value) ? value : undefined);
}

/** A whole number from 0 below 2**53 (a boolean is not one). */
function count(value: unknown): unknown {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2 ** 53 ? value : undefined;
}

const IP_CHARS = /^[0-9A-Fa-f:.]{2,45}$/u; // no "%zone" and nothing else

function ip(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const text = pyStrip(value);
  if (!IP_CHARS.test(text)) return undefined;
  const parsed = parseIpAddress(text);
  if (parsed === null) return undefined;
  // The normalised address passes the same checks as every other string: its groups can spell a code. The fixed
  // "::ffff:" of an IPv4-mapped address is not checked as a group ("FFFF" is code letters); its IPv4 part is.
  return refused(parsed.mappedV4 ?? parsed.address) ? undefined : parsed.address;
}

/** Category field -> the values it takes. Categories are chosen by the code, never by a person. */
export const CATEGORIES: Readonly<Record<string, ReadonlySet<string>>> = {
  outcome: new Set([
    "success",
    "failure",
    "wrong",
    "expired",
    "used",
    "locked",
    "global_limit",
    "merged",
    "failed",
    "confirmed",
    "declined",
  ]),
  reason: new Set([
    "missing_token",
    "bad_signature",
    "audience",
    "issuer",
    "expired",
    "not_yet_valid",
    "service_url",
    "malformed",
    "not_configured",
    "key_unavailable",
    "user_request",
    "rejected",
    "user_limit",
    "global_limit",
    "concurrency_limit",
    "not_allowed",
    "not_linked",
    "not_a_review_request",
    "not_shown",
    "other",
  ]),
  scope: new Set(["user", "global", "conversation"]),
  operation: new Set([
    "message",
    "link",
    "pr_merge",
    "pr_review",
    "approval",
    "remote_agent",
    "assistant_task",
    "claw_turn",
    "on_behalf",
  ]),
  decision: new Set(["approve", "deny", "confirm", "decline"]),
};

/** Field name -> its check. */
export const FIELDS: Readonly<Record<string, FieldCheck>> = {
  // ids
  aad_object_id: shaped(GUID, true), // the channel user's directory object id
  activity_id: shaped(ID),
  conversation_id: shaped(ID),
  session_id: shaped(ID), // Claw session id
  run_id: shaped(ID), // Claw run id
  approval_id: shaped(ID),
  correlation_id: shaped(CORRELATION), // ties the records of one operation together
  // categories
  ...Object.fromEntries(Object.entries(CATEGORIES).map(([name, values]) => [name, oneOf(values)])),
  // shaped values
  repo: shaped(REPO), // owner/name
  pr_number: count,
  branch: shaped(BRANCH),
  tool: shaped(TOOL), // tool name, never its input
  github_login: shaped(LOGIN), // the identity an operation ran as
  service_url_host: shaped(HOST, true),
  client_ip: ip,
  // numbers
  count,
  limit: count,
  window_seconds: count,
  retry_after_seconds: count,
  status: count, // an HTTP status code
};
