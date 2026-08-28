// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A comparable summary of what a sandbox was built with.
 *
 * Reuse used to be decided on liveness alone -- a KV entry marked ready, one
 * /health GET, a non-empty token -- and the check ran before the request was
 * even parsed, so it had no idea what the caller was asking for. Change the
 * image or the resources and the next message silently landed in the sandbox
 * built for the previous one.
 */

import { createHash, createHmac } from "node:crypto";

/** The parts of a request that are baked into the sandbox and cannot change after create. */
export interface SandboxSpecFacts {
  image: string;
  /** Normalized SaFE resource keys: cpu / memory / gpu / ephemeralStorage. */
  resources: Record<string, string>;
  /** Env the caller declared: the spec's own env plus user_env and session_env. */
  env: Record<string, string>;
  /** Business timeout in seconds; the platform kills the workload at it. */
  timeout?: number;
  /** Idle TTL in seconds, as passed to create. */
  ttlSec?: number;
  /** Only the labels the caller declared; the rest are derived per run. */
  labels?: Record<string, string>;
  /** The namespace the pod is created in, which a request can choose. */
  namespace?: string;
  /** The caller's LLM key. Hashed here and never stored or logged in full. */
  llmKey?: string;
}

/**
 * What is deliberately left out, and it is a closed list.
 *
 * The generated per-sandbox values -- bearer token, session id, MCP port,
 * workspace path -- because the token is fresh on every create, so folding it in
 * would mean no sandbox ever matched itself.
 *
 * The Brain-wide system env, because it is not part of the caller's request and
 * an admin editing one variable would invalidate every live sandbox in the fleet
 * at once. That leaves a real gap: a system env change does not reach sandboxes
 * that already exist. It is the same gap as before this fingerprint existed,
 * narrowed rather than widened, and closing it needs a rollout story rather
 * than a comparison.
 *
 * The derived labels -- session id, dag root, dag node, plugin id -- because
 * the dag root falls back to the task id, which is new on every run, so a
 * fingerprint carrying them would never match twice and every message would
 * rebuild.
 *
 * Everything else the caller can set and create then freezes belongs here. The
 * ones that are easy to miss are the last four fields above: they do not look
 * like "the spec", but a workload is killed at its timeout, evicted at its TTL,
 * scheduled into its namespace and authenticated with the key that was injected
 * at create, and none of the four can be changed afterwards.
 */
export function sandboxSpecFingerprint(facts: SandboxSpecFacts): string {
  // Sorted keys, because two requests that differ only in the order their env
  // arrived describe the same sandbox.
  const canonical = JSON.stringify({
    image: facts.image.trim(),
    resources: sortedEntries(facts.resources),
    env: sortedEntries(facts.env),
    timeout: facts.timeout ?? null,
    ttlSec: facts.ttlSec ?? null,
    labels: sortedEntries(facts.labels ?? {}),
    namespace: facts.namespace ?? "",
    // MAC'd before it joins the rest so the key never appears in a string
    // this process holds, even transiently.
    llmKey: fingerprintLlmKey(facts.llmKey),
  });
  // A format prefix, not part of the hash, so a comparison change can be told
  // apart from a spec change. evaluateReuse treats a different format as a
  // missing fingerprint rather than a rebuild: tearing the fleet down over
  // the comparison itself is worse than one more session on a stale spec, and
  // rewriting the stored value would make an older Brain see a mismatch and
  // destroy a sandbox it still knows how to read.
  return `${SPEC_FINGERPRINT_FORMAT}:${sha256(canonical).slice(0, 16)}`;
}

const SPEC_FINGERPRINT_FORMAT = 3;

/**
 * Comparison tag of the caller's LLM key.
 *
 * The key is HMAC keying material for a sandbox-reuse identifier, not a
 * password being stored. A password KDF would be the wrong primitive --
 * slow, salted, and not stable across hosts.
 */
function fingerprintLlmKey(key: string | undefined): string {
  if (!key) return "";
  return createHmac("sha256", key)
    .update("claw.sandbox.spec-fingerprint")
    .digest("hex");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sortedEntries(m: Record<string, string>): Array<[string, string]> {
  return Object.entries(m ?? {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export type ReuseVerdict =
  | { reuse: true; reason: "spec_match" | "no_recorded_spec" | "spec_format_changed" }
  | { reuse: false; reason: "spec_changed"; recorded: string; requested: string };

/**
 * Whether a live sandbox may serve this request.
 *
 * An entry with no recorded fingerprint is accepted. Every sandbox that exists
 * at the moment this ships predates the field, so rejecting them would tear
 * down the running fleet in one sweep the first time a Brain with this code
 * starts -- a far worse outcome than one more session on a stale spec, which is
 * what those sessions already have.
 *
 * An entry whose fingerprint was written under an earlier format is accepted
 * the same way, and for the same reason: the hash inputs changed, not the
 * sandbox. The stored value is left alone so an older Brain still sees a
 * fingerprint it can match.
 */
export function evaluateReuse(recorded: unknown, requested: string): ReuseVerdict {
  if (typeof recorded !== "string" || recorded.length === 0) {
    return { reuse: true, reason: "no_recorded_spec" };
  }
  if (recorded === requested) return { reuse: true, reason: "spec_match" };
  if (fingerprintFormat(recorded) !== fingerprintFormat(requested)) {
    return { reuse: true, reason: "spec_format_changed" };
  }
  return { reuse: false, reason: "spec_changed", recorded, requested };
}

/** Unprefixed 16-hex strings are format 1, the hash this first shipped as. */
function fingerprintFormat(fp: string): string {
  const m = /^(\d+):/.exec(fp);
  return m ? m[1]! : "1";
}
