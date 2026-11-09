// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The shapes of internal detail in text the worker did not write (the Python worker's `public_error.py` patterns, read
 * with Python's semantics through `pyRegExp`).
 */
import { pyRegExp } from "../security/py-regex.js";

/** File extensions of code and config: "test-user.py" is a file the model talks about, not a host. */
const CODE_EXT = String.raw`py|pyi|js|mjs|ts|tsx|jsx|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|md|rst|txt|json|yaml|yml|toml|ini|cfg|conf|lock|html|css|sql|ipynb|csv|log`;

const INFRA = String.raw`gateway|proxy|api|svc|service|server|db|database|redis|postgres|pg|mysql|mongo|kafka|nats|broker|brain|backend|worker|controller|ingress|litellm|vault|etcd|minio|registry`;

/** A hyphenated name with a segment that names a piece of infrastructure (brain-gateway, primus-brain, claw-api). */
const SERVICE_NAME = String.raw`(?i:\b(?:[A-Za-z0-9]+-)+(?:${INFRA})\b|\b(?:litellm|primus|claw|brain)(?:-[A-Za-z0-9]+)+\b)`;

/** The same names written with underscores (litellm_proxy, brain_gateway): only in INTERNAL, never in ADDRESS. */
const SERVICE_NAME_UNDERSCORE = String.raw`(?i:\b(?:[A-Za-z0-9]+_)+(?:${INFRA})\b|\b(?:litellm|primus|claw|brain)(?:_[A-Za-z0-9]+)+\b)`;

const URL_SCHEME = String.raw`[A-Za-z][A-Za-z0-9+.-]{1,15}://`;
const IPV4 = String.raw`\b\d{1,3}(?:\.\d{1,3}){3}\b`;
const IPV6 = String.raw`\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b|\b[0-9A-Fa-f]{0,4}::[0-9A-Fa-f]{1,4}\b`;
const HOST_PORT = String.raw`\b[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*:\d{2,5}\b`;
const HOST_NAMES =
  String.raw`(?i:\blocalhost\b` +
  String.raw`|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:svc|cluster\.local|local|internal|corp|lan|intra|prod|production|stg|stage|staging|int|priv|private|home)\b` +
  String.raw`|\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?:\.[A-Za-z0-9-]+)*\.(?!(?:${CODE_EXT})\b)[A-Za-z][A-Za-z0-9-]*\b` +
  String.raw`|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|ai|us|cloud|dev)\b)`;
const STACK = String.raw`Traceback \(most recent call last\)|\bFile "[^"]+", line \d+|\bat [\w.$<>]+\([\w.]*:\d+\)`;

/** Shapes of internal detail. Any one of them is enough to keep the text back from the chat. */
export const INTERNAL = pyRegExp(
  [
    URL_SCHEME,
    IPV4,
    IPV6,
    HOST_PORT, // a bare service name too: redis:6379
    HOST_NAMES,
    String.raw`(?:^|[\s'"(=:])(?:~|\.{1,2})?/[A-Za-z0-9._-]+/[^\s]*`, // a POSIX path with two segments or more
    SERVICE_NAME,
    SERVICE_NAME_UNDERSCORE,
    String.raw`\b[A-Za-z]:\\`, // a Windows path
    STACK,
    String.raw`\b[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)\b`, // an exception class name
    "[{}]", // JSON
  ].join("|"),
);

/** The subset of INTERNAL that is an address or a crash, not just words a person writes. */
export const ADDRESS = pyRegExp([URL_SCHEME, IPV4, IPV6, HOST_PORT, HOST_NAMES, STACK, SERVICE_NAME].join("|"));

/** Words of a failure: live narration that has internal detail and one of these is held back. */
export const FAILURE_WORDS = pyRegExp(
  String.raw`(?i)\b(?:error|errors|err|failed|failure|fails|fail|refused|unreachable|timed out|timeout|` +
    String.raw`exception|unavailable|denied|forbidden|unauthorized|traceback|reset|abort|aborted|closed|` +
    String.raw`broken pipe|eof|connection|connect|dial|no such host|not found|panic|fatal|` +
    String.raw`econn[a-z]*|enotfound|etimedout|status|[45]\d\d)\b`,
);

const STATUS_AFTER_CLASSES = String.raw`\A\s*(?:(?:API |[A-Za-z_.]{1,40})Error:\s*){0,3}[1-5]\d\d\b|\A\s*Traceback \(most recent call last\)`;

/** The start of the error Brain writes for a model call that failed: optional error classes, then the HTTP status. */
export const SERVICE_ERROR = pyRegExp(
  STATUS_AFTER_CLASSES + String.raw`|\A\s*(?:API Error|[A-Za-z_.]{0,40}(?:Error|Exception))\s*:`,
);

/** The part of SERVICE_ERROR that is never the model's own words (a bare "ValueError: ..." may be). */
export const BRAIN_ERROR = pyRegExp(
  STATUS_AFTER_CLASSES + String.raw`|\A\s*(?:API Error|[A-Za-z_]{1,30}\.[A-Za-z_.]{0,40}(?:Error|Exception))\s*:`,
);

/** Credentials a URL can carry in its user-info part (scheme://user:password@host). */
export const USERINFO = pyRegExp(String.raw`(?i)\b([a-z][a-z0-9+.-]{1,15}://)[^/\s@]{1,256}@`, "g");

/** Links to well-known public sites the model cites while it works: no internal endpoint, so no sign of an error. */
export const PUBLIC_LINK = pyRegExp(
  String.raw`(?i)(?<![\w.@-])(?:https?://)?(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|github\.io|pypi\.org|python\.org|` +
    String.raw`npmjs\.com|stackoverflow\.com|wikipedia\.org|readthedocs\.io|kubernetes\.io|go\.dev|docs\.docker\.com|learn\.microsoft\.com)` +
    String.raw`(?![\w.:@-])(?:/[^\s)\]>"']*)?`,
  "g",
);

/** A line that opens or closes a code fence. */
export const FENCE = pyRegExp(String.raw`\A\s*(?:` + "```" + String.raw`|~~~)`);
