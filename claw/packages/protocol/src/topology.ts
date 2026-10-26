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

import { PG_INT4_MAX } from "@claw/utils";

/** The engines a multi-node run can be provisioned onto. */
export const TOPOLOGY_BACKENDS = ["rayjob", "infera", "atom", "sglangrouter"] as const;
export type TopologyBackend = (typeof TOPOLOGY_BACKENDS)[number];

/** Backends that launch from a model path/id and must refuse a missing `--model`. */
export function backendRequiresModel(backend: TopologyBackend): boolean {
  return backend === "infera" || backend === "atom" || backend === "sglangrouter";
}

/** Atom and SGLangRouter are always router+prefill+decode; aggregated is not offered. */
export function backendRequiresDisaggregatedPd(backend: TopologyBackend): boolean {
  return backend === "atom" || backend === "sglangrouter";
}

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
  /** Model path or id. Required by infera, atom, and sglangrouter engines, unused by rayjob. */
  model?: string;
  framework?: (typeof TOPOLOGY_FRAMEWORKS)[number];
  pd_transfer_backend?: (typeof TOPOLOGY_KV_BACKENDS)[number];
  pd_mode?: (typeof TOPOLOGY_PD_MODES)[number];
  pd_prefill_nodes?: number;
  pd_decode_nodes?: number;
  pd_prefill_tp?: number;
  pd_decode_tp?: number;
  /** Engine flags from `--server-args`, appended as given. */
  server_args?: string;
  /** Per-role engine flags from `--pd-prefill-extra-args`. */
  pd_prefill_extra_args?: string;
  /** Per-role engine flags from `--pd-decode-extra-args`. */
  pd_decode_extra_args?: string;
  /** IB device list from `--pd-ib-device`. */
  pd_ib_device?: string;
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

const STRING_FIELDS = [
  "image",
  "model",
  "server_args",
  "pd_prefill_extra_args",
  "pd_decode_extra_args",
  "pd_ib_device",
] as const;

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
    // The upper bound is `int4`, not taste: admission sums these across rows
    // and `claw_tasks.input->'topology'->>'nodes'` is cast to an integer there,
    // so a value the column cannot express aborts the aggregate for every run.
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)
        || v > PG_INT4_MAX) {
      errors.push(`topology.${field} must be a whole number between 0 and ${PG_INT4_MAX}`);
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
    errors.push("topology.backend is required: rayjob, infera, atom, or sglangrouter");
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

  const backend = typeof raw.backend === "string"
    && (TOPOLOGY_BACKENDS as readonly string[]).includes(raw.backend)
    ? raw.backend as TopologyBackend
    : undefined;

  if (backend && backendRequiresModel(backend) && !String(raw.model ?? "").trim()) {
    // Infera's frontend takes it as --router-tokenizer-path. Atom and
    // SGLangRouter prefill and decode take it as --model-path. Without it the
    // cluster comes up and the serving process cannot start.
    errors.push(`topology.model is required when backend is ${backend}`);
  }

  if (backend && backendRequiresDisaggregatedPd(backend)) {
    errors.push(...pdClusterShapeErrors(raw, backend));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: raw as unknown as EnvironmentTopology };
}

/** GPU count used when a request omits gpus_per_node. */
export const DEFAULT_GPUS_PER_NODE = 8;

export interface PdClusterShape {
  backend: string;
  /** Omitted means the builder default, disaggregated. */
  pdMode?: string;
  nodes: number;
  gpusPerNode?: number;
  pdPrefillNodes?: number;
  pdDecodeNodes?: number;
  pdPrefillTp?: number;
  pdDecodeTp?: number;
}

export type PdClusterProblem =
  | { kind: "pd_mode"; got: string }
  | { kind: "partial_roles" }
  | { kind: "min_nodes"; nodes: number }
  | { kind: "role_sum"; nodes: number; total: number }
  | { kind: "tp"; role: "prefill" | "decode"; tp: number; gpus: number };

/**
 * Shape rules for an Atom or SGLangRouter cluster.
 *
 * Explicit prefill and decode counts must both be set and sum to nodes.
 * Otherwise nodes is split evenly, which requires at least two nodes.
 */
export function pdClusterProblems(shape: PdClusterShape): PdClusterProblem[] {
  const problems: PdClusterProblem[] = [];
  if (shape.pdMode !== undefined && shape.pdMode !== "disaggregated") {
    problems.push({ kind: "pd_mode", got: shape.pdMode });
  }
  const gpus = shape.gpusPerNode && shape.gpusPerNode > 0
    ? shape.gpusPerNode
    : DEFAULT_GPUS_PER_NODE;
  const prefill = shape.pdPrefillNodes ?? 0;
  const decode = shape.pdDecodeNodes ?? 0;
  if ((prefill > 0) !== (decode > 0)) {
    problems.push({ kind: "partial_roles" });
  } else if (prefill > 0) {
    const total = prefill + decode;
    if (shape.nodes !== total) {
      problems.push({ kind: "role_sum", nodes: shape.nodes, total });
    }
  } else if (shape.nodes < 2) {
    problems.push({ kind: "min_nodes", nodes: shape.nodes });
  }
  const tp: Array<["prefill" | "decode", number]> = [
    ["prefill", shape.pdPrefillTp ?? 0],
    ["decode", shape.pdDecodeTp ?? 0],
  ];
  for (const [role, value] of tp) {
    if (value > gpus) problems.push({ kind: "tp", role, tp: value, gpus });
  }
  return problems;
}

/**
 * Prefill and decode replica counts. Explicit counts win; otherwise nodes is
 * split evenly. Returns the first count problem instead of a pair.
 */
export function splitPdReplicas(
  nodes: number,
  prefillNodes: number,
  decodeNodes: number,
): { ok: true; prefill: number; decode: number } | { ok: false; problem: PdClusterProblem } {
  const problem = pdClusterProblems({
    backend: "pd-cluster",
    nodes,
    pdPrefillNodes: prefillNodes,
    pdDecodeNodes: decodeNodes,
  }).find((item) => item.kind === "partial_roles" || item.kind === "min_nodes" || item.kind === "role_sum");
  if (problem) return { ok: false, problem };
  if (prefillNodes > 0 && decodeNodes > 0) {
    return { ok: true, prefill: prefillNodes, decode: decodeNodes };
  }
  const prefill = Math.floor(nodes / 2);
  return { ok: true, prefill, decode: nodes - prefill };
}

/**
 * Admission text for the shared PD-cluster shape rules.
 * A missing pd_mode is accepted: the builder defaults it to disaggregated.
 */
function pdClusterShapeErrors(
  raw: Record<string, unknown>,
  backend: TopologyBackend,
): string[] {
  const nodes = typeof raw.nodes === "number" ? raw.nodes : 0;
  return pdClusterProblems({
    backend,
    pdMode: typeof raw.pd_mode === "string" ? raw.pd_mode : undefined,
    nodes,
    gpusPerNode: typeof raw.gpus_per_node === "number" ? raw.gpus_per_node : undefined,
    pdPrefillNodes: typeof raw.pd_prefill_nodes === "number" ? raw.pd_prefill_nodes : undefined,
    pdDecodeNodes: typeof raw.pd_decode_nodes === "number" ? raw.pd_decode_nodes : undefined,
    pdPrefillTp: typeof raw.pd_prefill_tp === "number" ? raw.pd_prefill_tp : undefined,
    pdDecodeTp: typeof raw.pd_decode_tp === "number" ? raw.pd_decode_tp : undefined,
  }).map((problem) => pdClusterAdmissionMessage(backend, problem));
}

function pdClusterAdmissionMessage(backend: string, problem: PdClusterProblem): string {
  switch (problem.kind) {
    case "pd_mode":
      return `topology.pd_mode ${problem.got} is not supported when backend is ${backend}`;
    case "partial_roles":
      return `topology.pd_prefill_nodes and topology.pd_decode_nodes must both be set when backend is ${backend}`;
    case "min_nodes":
      return `topology.nodes (${problem.nodes}) must be at least 2 when backend is ${backend}`;
    case "role_sum":
      return `topology.nodes (${problem.nodes}) must equal prefill+decode GPU nodes (${problem.total}) when backend is ${backend}`;
    case "tp":
      return `topology.pd_${problem.role}_tp (${problem.tp}) exceeds gpus_per_node (${problem.gpus}); cross-pod TP is not supported`;
  }
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
