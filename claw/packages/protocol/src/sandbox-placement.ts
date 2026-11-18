// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a session's sandboxes may be scheduled: `placement = { nodeLabels }`.
 *
 * Each entry becomes one SaFE `customerLabels` entry on every sandbox workload
 * the session creates, which the platform turns into a required node affinity
 * (`<key> In [<value>]`). A sandbox with a placement therefore waits for a node
 * carrying every label rather than running anywhere else.
 *
 * One definition, used twice: the API refuses a malformed value at
 * `POST /v1/sessions`, before any row exists, and Brain checks it again before
 * the workload is created, because Brain does not know the value came through
 * that door.
 *
 * Narrower than what SaFE stores, on purpose:
 *  - a value is one label value. SaFE splits a value on whitespace into an `In`
 *    list, so "a b" would mean "a or b"; a label value cannot hold whitespace,
 *    and every value here is a single token.
 *  - the keys SaFE gives a meaning of its own are refused (the node-name keys
 *    and the platform's own label namespaces); a caller can only narrow where
 *    the sandbox runs, never name nodes or step outside its workspace.
 */

export interface SandboxPlacement {
  /** Node labels every sandbox of the session requires, label key to label value. */
  nodeLabels: Record<string, string>;
}

export type SandboxPlacementParse =
  | { ok: true; placement: SandboxPlacement | null }
  | { ok: false; error: string };

/** The most node labels a placement may name. */
export const SANDBOX_PLACEMENT_MAX_NODE_LABELS = 8;

/**
 * Keys SaFE reads as something other than a node label: the node-name
 * constraints (pinning or excluding hosts by name), and the workspace
 * confinement labels the platform sets itself.
 */
export const SANDBOX_PLACEMENT_RESERVED_KEYS: readonly string[] = Object.freeze([
  "kubernetes.io/hostname",
  "specified-nodes",
  "excluded-nodes",
  "autopilot.amd.com/w",
  "safe-exec.amd.com/w",
]);

/** Label-key prefixes that belong to the platform (`primus-safe.workspace.id` and the rest). */
export const SANDBOX_PLACEMENT_RESERVED_PREFIXES: readonly string[] = Object.freeze(["primus-safe."]);

const NAME_MAX = 63;
const PREFIX_MAX = 253;
/** A label name, and a non-empty label value: alphanumeric at both ends, `-`, `_`, `.` inside. */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
/** A DNS subdomain: lowercase labels separated by dots. */
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function keyError(key: string): string | null {
  const where = `placement.nodeLabels key ${JSON.stringify(key.slice(0, 80))}`;
  const slash = key.indexOf("/");
  const prefix = slash >= 0 ? key.slice(0, slash) : null;
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  if (prefix !== null) {
    if (prefix.length === 0 || prefix.length > PREFIX_MAX || !prefix.split(".").every((l) => DNS_LABEL_RE.test(l))) {
      return `${where} is not a label key: the prefix must be a DNS subdomain of at most ${PREFIX_MAX} characters`;
    }
  }
  if (name.length === 0 || name.length > NAME_MAX || !NAME_RE.test(name)) {
    return `${where} is not a label key: the name must be 1-${NAME_MAX} characters, alphanumeric at both ends, `
      + "with only '-', '_' or '.' inside, after an optional 'prefix/'";
  }
  if (SANDBOX_PLACEMENT_RESERVED_KEYS.includes(key)
    || SANDBOX_PLACEMENT_RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
    return `${where} is reserved by the platform and cannot be used for placement`;
  }
  return null;
}

function valueError(key: string, value: unknown): string | null {
  const where = `placement.nodeLabels[${JSON.stringify(key.slice(0, 80))}]`;
  if (typeof value !== "string") return `${where} must be a string (quote it, e.g. "false")`;
  if (value.length === 0 || value.length > NAME_MAX || !NAME_RE.test(value)) {
    return `${where} is not a label value: one token of 1-${NAME_MAX} characters, alphanumeric at both ends, `
      + "with only '-', '_' or '.' inside and no whitespace";
  }
  return null;
}

/**
 * Check a `placement` value as a client sent it.
 *
 * `undefined`, `null`, `{}` and an empty `nodeLabels` all mean no placement, and
 * parse to `null`: a session without one is exactly what it was before the
 * field existed. Anything else that is not a well-formed placement is refused
 * with a message that names the offending entry.
 */
export function parseSandboxPlacement(raw: unknown): SandboxPlacementParse {
  if (raw === undefined || raw === null) return { ok: true, placement: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "placement must be an object such as {\"nodeLabels\": {\"<key>\": \"<value>\"}}" };
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== "nodeLabels") return { ok: false, error: `placement.${k.slice(0, 80)} is not a known field (only nodeLabels)` };
  }
  const labels = obj.nodeLabels;
  if (labels === undefined || labels === null) return { ok: true, placement: null };
  if (typeof labels !== "object" || Array.isArray(labels)) {
    return { ok: false, error: "placement.nodeLabels must be an object of label key to label value" };
  }
  const entries = Object.entries(labels as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, placement: null };
  if (entries.length > SANDBOX_PLACEMENT_MAX_NODE_LABELS) {
    return {
      ok: false,
      error: `placement.nodeLabels has ${entries.length} entries; at most ${SANDBOX_PLACEMENT_MAX_NODE_LABELS} are allowed`,
    };
  }
  const nodeLabels: Record<string, string> = {};
  for (const [key, value] of entries) {
    const err = keyError(key) ?? valueError(key, value);
    if (err) return { ok: false, error: err };
    nodeLabels[key] = value as string;
  }
  return { ok: true, placement: { nodeLabels } };
}
