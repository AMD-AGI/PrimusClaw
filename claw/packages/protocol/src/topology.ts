// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a run says it needs, as a declaration rather than as prose.
 *
 * Multi-node provisioning has been driven by Hyperloom `optimize` flags read
 * out of the prompt with a regular expression: `--nodes 64 --mn-backend
 * infera`. That has two costs, and neither is stylistic.
 *
 * The first is that a typo is indistinguishable from silence. `--node 64`
 * matches nothing, `requestedNodeCount` returns its default of 1, and the run
 * proceeds as an ordinary single-node task -- so a request for sixty-four GPU
 * machines quietly becomes a request for none, and the first sign of it is a
 * job that runs on the wrong scale.
 *
 * The second is that nothing upstream of Brain can see the request. Admission
 * and quota run in the API, on the request body; the flags are inside a string
 * that only Brain parses, and only after the message has been accepted,
 * queued, and picked up. There is no point at which "this run wants 64 GPU
 * nodes" is a fact anything but Brain could act on. A declared field is that
 * point.
 *
 * So the body is the source of truth, and the prompt flags remain as a
 * fallback for callers that have not moved. Validation is strict in both
 * directions: an unknown key is a rejection rather than a default, because the
 * whole failure being fixed here is a misspelling that reads as a request for
 * something smaller.
 */

/** The engines a multi-node run can be provisioned onto. */
export const TOPOLOGY_BACKENDS = ["rayjob", "infera"] as const;
export type TopologyBackend = (typeof TOPOLOGY_BACKENDS)[number];

export const TOPOLOGY_FRAMEWORKS = ["sglang", "vllm"] as const;
export const TOPOLOGY_KV_BACKENDS = ["nixl", "mori", "mooncake"] as const;
export const TOPOLOGY_PD_MODES = ["aggregated", "disaggregated"] as const;

/**
 * The environment a run asks for.
 *
 * Field names mirror the Hyperloom flags they replace, in snake_case, so the
 * translation between the two is mechanical and reviewable.
 */
export interface EnvironmentTopology {
  /** Total GPU nodes including the head. Two or more makes the run multi-node. */
  nodes: number;
  /** Which distributed engine provisions them. Required: there is no default worth guessing. */
  backend: TopologyBackend;
  gpus_per_node?: number;
  cpus_per_node?: number;
  mem_per_node_gib?: number;
  /** Cluster image; falls back to the sandbox image when absent. */
  image?: string;
  /** Model path or id. Required by the infera frontend, unused by rayjob. */
  model?: string;
  framework?: (typeof TOPOLOGY_FRAMEWORKS)[number];
  pd_transfer_backend?: (typeof TOPOLOGY_KV_BACKENDS)[number];
  pd_mode?: (typeof TOPOLOGY_PD_MODES)[number];
  pd_prefill_nodes?: number;
  pd_decode_nodes?: number;
  pd_prefill_tp?: number;
  pd_decode_tp?: number;
  /** Variables injected into the cluster containers. */
  extra_env?: Record<string, string>;
}

/**
 * Names owned by the platform's own templates, which a caller may not set.
 *
 * Same rule the prompt parser applies to `--extra-env`, kept in one place so
 * the two routes into the cluster's environment cannot disagree about it.
 */
export const RESERVED_TOPOLOGY_ENV = new Set([
  "RAY_JOB_ENTRYPOINT",
  "MN_SSH_AUTHORIZED_KEY",
  "MN_SSH_PORT",
]);

const NUMERIC_FIELDS = [
  "nodes",
  "gpus_per_node",
  "cpus_per_node",
  "mem_per_node_gib",
  "pd_prefill_nodes",
  "pd_decode_nodes",
  "pd_prefill_tp",
  "pd_decode_tp",
] as const;

const STRING_FIELDS = ["image", "model"] as const;

const ENUM_FIELDS: Record<string, readonly string[]> = {
  backend: TOPOLOGY_BACKENDS,
  framework: TOPOLOGY_FRAMEWORKS,
  pd_transfer_backend: TOPOLOGY_KV_BACKENDS,
  pd_mode: TOPOLOGY_PD_MODES,
};

const KNOWN_FIELDS = new Set<string>([
  ...NUMERIC_FIELDS,
  ...STRING_FIELDS,
  ...Object.keys(ENUM_FIELDS),
  "extra_env",
]);

export type TopologyValidation =
  | { ok: true; value: EnvironmentTopology }
  | { ok: false; errors: string[] };

/**
 * Check a declared topology, reporting every problem rather than the first.
 *
 * Strict about unknown keys on purpose. A caller who writes `node_count` has
 * asked for something, and the helpful-sounding alternative -- ignore what we
 * do not recognise -- turns that into a silent single-node run, which is the
 * exact failure the declaration exists to remove.
 */
export function validateTopology(input: unknown): TopologyValidation {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["topology must be an object"] };
  }
  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      const suggestion = nearestField(key);
      errors.push(
        `topology.${key} is not a field`
        + (suggestion ? `; did you mean ${suggestion}?` : ""),
      );
    }
  }

  for (const field of NUMERIC_FIELDS) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      errors.push(`topology.${field} must be a non-negative whole number`);
    }
  }
  for (const field of STRING_FIELDS) {
    const v = raw[field];
    if (v !== undefined && typeof v !== "string") {
      errors.push(`topology.${field} must be a string`);
    }
  }
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || !allowed.includes(v)) {
      errors.push(`topology.${field} must be one of ${allowed.join(", ")}`);
    }
  }

  if (raw.nodes === undefined) errors.push("topology.nodes is required");
  if (raw.backend === undefined) {
    // No default: `--nodes` alone used to be enough to provision a cluster on
    // whichever engine happened to be first, which is a large thing to get by
    // omission.
    errors.push("topology.backend is required: rayjob or infera");
  }
  if (typeof raw.nodes === "number" && raw.nodes < 1) {
    errors.push("topology.nodes must be at least 1");
  }

  if (raw.extra_env !== undefined) {
    if (typeof raw.extra_env !== "object" || raw.extra_env === null || Array.isArray(raw.extra_env)) {
      errors.push("topology.extra_env must be an object of name to value");
    } else {
      for (const [name, value] of Object.entries(raw.extra_env as Record<string, unknown>)) {
        if (typeof value !== "string") {
          errors.push(`topology.extra_env.${name} must be a string`);
        } else if (RESERVED_TOPOLOGY_ENV.has(name)) {
          errors.push(`topology.extra_env.${name} is set by the platform and cannot be overridden`);
        }
      }
    }
  }

  if (raw.backend === "infera" && !String(raw.model ?? "").trim()) {
    // The infera frontend takes it as --router-tokenizer-path; without it the
    // cluster comes up and the frontend cannot start.
    errors.push("topology.model is required when backend is infera");
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: raw as unknown as EnvironmentTopology };
}

/**
 * The known field a misspelling is closest to, if it is close enough to be
 * worth naming. Two edits, which covers the realistic cases -- a dropped
 * letter, a plural, a transposition, a singular for a plural -- without
 * inventing a guess for a name that was never meant to be one of these.
 */
function nearestField(key: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of KNOWN_FIELDS) {
    const d = editDistance(key.toLowerCase(), candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return bestDistance <= 2 ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}
