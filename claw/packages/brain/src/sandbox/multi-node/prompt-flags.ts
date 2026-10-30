// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Multi-node provisioning is driven by the Hyperloom `optimize` flags written
// in the task prompt, not by the request body. The flags are literal text, so
// they are parsed deterministically here -- no LLM round-trip, which also
// matters because the cluster is provisioned before the engine ever runs.
//
// A task is multi-node only when BOTH hold: `--nodes` >= 2 AND `--mn-backend`
// names a known engine. Requiring the backend explicitly keeps a bare `--nodes`
// from silently provisioning a GPU cluster on whichever engine happened to be
// the default.
//
// Flag names, units and defaults mirror Hyperloom
// `inference_optimizer/cli/parser.py`:
//   --nodes                total GPU nodes (head + workers), default 1
//   --mn-backend           rayjob | infera | atom | sglangrouter; no default, required for multi-node
//   --mn-image             cluster image; falls back to the sandbox image
//   --gpus-per-node        default 8
//   --cpus-per-node        default 96
//   --mem-per-node         GiB, default 1024
//   --model                model path/id (infera frontend, or atom/sglangrouter --model-path)
//   --framework            sglang | vllm, default sglang. Atom router --backend and
//                          Infera backendFramework take this value.
//   --server-args          engine flags, appended as given
//   --pd-prefill-extra-args / --pd-decode-extra-args   per-role engine flags
//   --pd-ib-device         IB device list for the disaggregation plane
//   --pd-transfer-backend  nixl | mori | mooncake. Default mori, except atom and
//                          sglangrouter, which default to mooncake.
//   --pd-mode              aggregated | disaggregated. Default aggregated, except
//                          atom and sglangrouter, which can only be disaggregated.
//   --pd-prefill-nodes / --pd-decode-nodes    PD group node counts
//   --pd-prefill-tp    / --pd-decode-tp       PD group tensor-parallel sizes
//   --extra-env K=V    repeatable; the only way to reach the GPU pods' env
//
// Imports are limited to types and pure protocol helpers, so tests can load
// this without pulling in the k8s client.
import {
  TOPOLOGY_BACKENDS,
  backendRequiresDisaggregatedPd,
  backendRequiresModel,
  validateTopology,
  type EnvironmentTopology,
  type TopologyBackend,
  DEFAULT_GPUS_PER_NODE,
  pdClusterProblems,
  splitPdReplicas,
  type PdClusterProblem,
} from "@claw/protocol";
import { SandboxFailure } from "../errors.js";

/** Ephemeral storage per node; not expressible as a Hyperloom flag. */
const EPHEMERAL_STORAGE_PER_NODE = "200Gi";

const DEFAULT_NODES = 1;
const DEFAULT_CPUS_PER_NODE = 96;
const DEFAULT_MEM_PER_NODE_GIB = 1024;
const DEFAULT_FRAMEWORK = "sglang";
const DEFAULT_KV_TRANSFER_BACKEND = "mori";
/** Used when atom or sglangrouter omits --pd-transfer-backend. */
const PD_CLUSTER_KV_TRANSFER_BACKEND = "mooncake";

/** Enum values mirrored from the SaFE Infera webhook. */
const INFERA_FRAMEWORKS = new Set(["sglang", "vllm"]);
const INFERA_KV_BACKENDS = new Set(["nixl", "mori", "mooncake"]);

/**
 * Reserved by the RayJob template (base64 payload the submitter decodes), so
 * `--extra-env` may not override it -- same rule Hyperloom's own CLI documents
 * for this flag. `MN_SSH_*` are owned by the Infera idle-pod control plane (see
 * sandbox/multi-node/safe-body.ts) for the same reason.
 */
const RESERVED_EXTRA_ENV = new Set([
  "RAY_JOB_ENTRYPOINT",
  "MN_SSH_AUTHORIZED_KEY",
  "MN_SSH_PORT",
]);

export type MultiNodeBackendFlag = TopologyBackend;
export type PdMode = "aggregated" | "disaggregated";

export interface MultiNodePromptSpec {
  /** Total GPU nodes, head included (`--nodes`). */
  nodes: number;
  gpusPerNode: number;
  cpusPerNode: number;
  memPerNodeGiB: number;
  /** Normalised `--mn-backend`; always one of the enum, never inferred. */
  backend: MultiNodeBackendFlag;
  /** `--mn-image`; empty when absent, callers fall back to the sandbox image. */
  image: string;
  /** `--extra-env K=V` entries (repeatable), injected into the cluster containers. */
  extraEnv: Record<string, string>;
  /** `--model`; required by infera, atom, and sglangrouter, unused by rayjob. */
  model: string;
  /** `--framework`. Atom router `--backend` and Infera `backendFramework`. */
  framework: string;
  /** `--pd-transfer-backend`, validated against the Infera KV enum. */
  kvTransferBackend: string;
  pdMode: PdMode;
  pdPrefillNodes: number;
  pdDecodeNodes: number;
  pdPrefillTp: number;
  pdDecodeTp: number;
  /** `--server-args`, appended to each engine command. */
  serverArgs: string;
  /** `--pd-prefill-extra-args`, appended after serverArgs on prefill. */
  pdPrefillExtraArgs: string;
  /** `--pd-decode-extra-args`, appended after serverArgs on decode. */
  pdDecodeExtraArgs: string;
  /** `--pd-ib-device`. Empty when the prompt does not set one. */
  pdIbDevice: string;
}

/**
 * Strip the markup a prompt wraps a flag in from its value.
 *
 * A prompt is prose as much as it is a command line, and a flag listed as a
 * markdown bullet -- `` `--nodes 2` `` -- ends its value with the closing
 * backtick, which `\S+` captures. The value is then `2\`` rather than `2` and
 * `infera\`` rather than `infera`: the first falls back to one node, the second
 * fails the backend enum, and both make the task read as single-node with no
 * flag misspelt anywhere.
 *
 * Only the outermost characters go, and only ones that cannot begin or end a
 * path, an image reference or a `K=V` pair, so a value that legitimately
 * contains them -- `rdma0,rdma1` -- keeps them.
 */
function stripFlagDecoration(raw: string): string {
  return raw.replace(/^[`"'([]+/, "").replace(/[`"')\],;]+$/, "");
}

/**
 * Read `--flag value` / `--flag=value` from a prompt. Only the first
 * occurrence counts, so a later mention inside e.g. `--server-args "..."`
 * cannot override the real flag.
 *
 * A value that is nothing but decoration reads as absent, so the caller takes
 * its default instead of an empty string.
 */
function readFlag(prompt: string, flag: string): string | undefined {
  const re = new RegExp(`--${flag}[\\s=]+(\\S+)`, "i");
  const raw = re.exec(prompt)?.[1];
  if (raw === undefined) return undefined;
  return stripFlagDecoration(raw) || undefined;
}

function readIntFlag(prompt: string, flag: string, fallback: number): number {
  const raw = readFlag(prompt, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Read a flag constrained to an enum; out-of-range values fall back. */
function readEnumFlag(
  prompt: string,
  flag: string,
  allowed: Set<string>,
  fallback: string,
): string {
  const raw = (readFlag(prompt, flag) ?? "").toLowerCase();
  return allowed.has(raw) ? raw : fallback;
}

/**
 * Read one argument string. A quoted value is taken whole, so the flags inside
 * `--server-args "..."` stay part of that value.
 */
function readArgString(prompt: string, flag: string): string {
  const re = new RegExp(`--${flag}(?:\\s+|=)\\s*`, "i");
  const found = re.exec(prompt);
  if (!found) return "";
  let i = found.index + found[0].length;
  // A leading backslash belongs to an escaped opener (`\"...\"`), not to the value.
  const openerEscaped = prompt[i] === "\\";
  if (openerEscaped) i += 1;
  const quote = prompt[i];
  if (quote === "\"" || quote === "'") {
    i += 1;
    let out = "";
    while (i < prompt.length) {
      const ch = prompt[i];
      // The same escape that opened the value closes it. A plain quote still
      // treats \" as a literal quote inside the value.
      if (openerEscaped && ch === "\\" && prompt[i + 1] === quote) break;
      if (ch === "\\" && (prompt[i + 1] === quote || prompt[i + 1] === "\\")) {
        out += prompt[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) break;
      out += ch;
      i += 1;
    }
    return out.trim();
  }
  const bare = /\S+/.exec(prompt.slice(i))?.[0] ?? "";
  return stripFlagDecoration(bare);
}

/** Read every occurrence of a repeatable flag (`--extra-env` is `action="append"`). */
function readRepeatedFlag(prompt: string, flag: string): string[] {
  const re = new RegExp(`--${flag}[\\s=]+(\\S+)`, "gi");
  const out: string[] = [];
  for (const m of prompt.matchAll(re)) {
    const value = m[1] ? stripFlagDecoration(m[1]) : "";
    if (value) out.push(value);
  }
  return out;
}

/** Accept a `K=V` pair into `out` unless the key is malformed or reserved. */
function acceptEnvEntry(out: Record<string, string>, raw: string): void {
  const eq = raw.indexOf("=");
  if (eq <= 0) return;
  const name = raw.slice(0, eq);
  if (!name || RESERVED_EXTRA_ENV.has(name)) return;
  out[name] = raw.slice(eq + 1);
}

/**
 * Environment forwarded to the multi-node containers, read from the single
 * `--extra-env K=V` flag (repeatable) for both backends.
 *
 * The prompt's free-form `Environment:` / `Pod-side env:` blocks are deliberately
 * NOT scraped: this parser is plain text matching with no LLM in the loop (the
 * cluster is provisioned before the engine ever runs), so prose blocks cannot be
 * classified reliably. A variable reaches the GPU pods only via this flag.
 */
function readExtraEnv(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readRepeatedFlag(prompt, "extra-env")) {
    acceptEnvEntry(out, raw);
  }
  return out;
}

/**
 * Total GPU nodes the prompt asks for, read on its own.
 *
 * Exported so a caller can tell an ordinary single-node task apart from a
 * multi-node one that failed the backend check -- both make the parse below
 * return null, but only the second is worth warning about.
 */
export function requestedNodeCount(prompt: string): number {
  return readIntFlag(String(prompt ?? ""), "nodes", DEFAULT_NODES);
}

/** Default PD mode. Atom and SGLangRouter have no aggregated shape. */
function defaultPdMode(backend: MultiNodeBackendFlag): PdMode {
  return backendRequiresDisaggregatedPd(backend) ? "disaggregated" : "aggregated";
}

/** Default KV transfer. Atom and SGLangRouter engines are written for Mooncake. */
function defaultKvTransferBackend(backend: MultiNodeBackendFlag): string {
  return backendRequiresDisaggregatedPd(backend)
    ? PD_CLUSTER_KV_TRANSFER_BACKEND
    : DEFAULT_KV_TRANSFER_BACKEND;
}

/** `--mn-backend`, or null when the flag is absent or outside the enum. */
function readBackendFlag(prompt: string): MultiNodeBackendFlag | null {
  const raw = (readFlag(prompt, "mn-backend") ?? "").toLowerCase();
  return (TOPOLOGY_BACKENDS as readonly string[]).includes(raw)
    ? (raw as MultiNodeBackendFlag)
    : null;
}

/**
 * Extract the multi-node spec from a prompt, or null when the task is not
 * multi-node: either `--nodes` < 2, or `--mn-backend` is missing/unknown.
 *
 * Both backends are returned; whether a backend can actually be provisioned
 * depends on the deploy mode (see multi-node/factory.ts -- the template
 * provider supports rayjob only).
 */
export function parseMultiNodePromptFlags(prompt: string): MultiNodePromptSpec | null {
  const text = String(prompt ?? "");
  if (!text) return null;

  const nodes = requestedNodeCount(text);
  if (nodes < 2) return null;

  const backend = readBackendFlag(text);
  if (!backend) return null;

  const pdModeFlag = (readFlag(text, "pd-mode") ?? "").toLowerCase();
  const pdMode: PdMode = pdModeFlag === "disaggregated" || pdModeFlag === "aggregated"
    ? pdModeFlag
    : defaultPdMode(backend);

  return {
    nodes,
    gpusPerNode: readIntFlag(text, "gpus-per-node", DEFAULT_GPUS_PER_NODE),
    cpusPerNode: readIntFlag(text, "cpus-per-node", DEFAULT_CPUS_PER_NODE),
    memPerNodeGiB: readIntFlag(text, "mem-per-node", DEFAULT_MEM_PER_NODE_GIB),
    backend,
    image: (readFlag(text, "mn-image") ?? "").trim(),
    extraEnv: readExtraEnv(text),
    model: (readFlag(text, "model") ?? "").trim(),
    framework: readEnumFlag(text, "framework", INFERA_FRAMEWORKS, DEFAULT_FRAMEWORK),
    kvTransferBackend: readEnumFlag(
      text,
      "pd-transfer-backend",
      INFERA_KV_BACKENDS,
      defaultKvTransferBackend(backend),
    ),
    pdMode,
    pdPrefillNodes: readIntFlag(text, "pd-prefill-nodes", 0),
    pdDecodeNodes: readIntFlag(text, "pd-decode-nodes", 0),
    pdPrefillTp: readIntFlag(text, "pd-prefill-tp", 0),
    pdDecodeTp: readIntFlag(text, "pd-decode-tp", 0),
    serverArgs: readArgString(text, "server-args"),
    pdPrefillExtraArgs: readArgString(text, "pd-prefill-extra-args"),
    pdDecodeExtraArgs: readArgString(text, "pd-decode-extra-args"),
    pdIbDevice: readArgString(text, "pd-ib-device"),
  };
}

/**
 * Fail fast when a backend that launches from `--model` is missing it, and when
 * Atom/SGLangRouter are asked for a topology they cannot provision.
 *
 * Infera's frontend takes the path as `--router-tokenizer-path`. Atom and
 * SGLangRouter prefill and decode take it as `--model-path`. Either cluster
 * would otherwise come up and then fail to serve.
 */
export function assertMultiNodeModel(spec: MultiNodePromptSpec): void {
  if (backendRequiresModel(spec.backend)) {
    if (!spec.model.trim()) {
      const where = spec.backend === "infera"
        ? "infera frontend --router-tokenizer-path"
        : `${spec.backend} prefill/decode --model-path`;
      const code = spec.backend === "infera" ? "infera_model_missing" : "mn_model_missing";
      throw new SandboxFailure(code, `model is required (${where})`);
    }
  }
  if (backendRequiresDisaggregatedPd(spec.backend)) {
    assertPdClusterPrompt(spec);
  }
}

/**
 * Atom/SGLangRouter are a router + prefill + decode cluster. Aggregated mode
 * is refused, and `--nodes` must match the GPU roles that will be created.
 */
export function assertPdClusterPrompt(spec: {
  backend: string;
  pdMode: string;
  framework: string;
  nodes: number;
  gpusPerNode: number;
  pdPrefillNodes: number;
  pdDecodeNodes: number;
  pdPrefillTp: number;
  pdDecodeTp: number;
}): void {
  const problem = pdClusterProblems(spec)[0];
  if (problem) throw pdClusterFailure(spec.backend, problem);
}

function pdClusterFailure(backend: string, problem: PdClusterProblem): SandboxFailure {
  return new SandboxFailure("mn_config_invalid", pdClusterPromptMessage(backend, problem));
}

function pdClusterPromptMessage(backend: string, problem: PdClusterProblem): string {
  switch (problem.kind) {
    case "pd_mode":
      return `${backend} requires --pd-mode disaggregated (got ${problem.got})`;
    case "partial_roles":
      return `${backend} requires both --pd-prefill-nodes and --pd-decode-nodes when either is set`;
    case "min_nodes":
      return `${backend} requires --nodes >= 2`;
    case "role_sum":
      return `${backend}: --nodes (${problem.nodes}) must equal prefill+decode GPU nodes (${problem.total})`;
    case "tp":
      return `${backend}: --pd-${problem.role}-tp (${problem.tp}) exceeds --gpus-per-node (${problem.gpus}); cross-pod TP is not supported`;
  }
}

/**
 * Prefill/decode replica counts for an Atom/SGLangRouter cluster.
 *
 * Explicit `--pd-*-nodes` win when either is set (both required). Otherwise
 * `--nodes` is split evenly across the two GPU roles so Hyperloom's
 * INFERENCE_OPTIMIZER_NODES matches the pods that will exist.
 */
export function resolvePdClusterReplicas(spec: {
  nodes: number;
  pdPrefillNodes: number;
  pdDecodeNodes: number;
  backend?: string;
}): { prefill: number; decode: number } {
  const split = splitPdReplicas(spec.nodes, spec.pdPrefillNodes, spec.pdDecodeNodes);
  if (!split.ok) throw pdClusterFailure(spec.backend ?? "pd-cluster", split.problem);
  return { prefill: split.prefill, decode: split.decode };
}

/** Ephemeral storage per node in GiB, for the SaFE workload bodies. */
export function ephemeralGiPerNode(): number {
  return Number.parseInt(EPHEMERAL_STORAGE_PER_NODE, 10);
}

/**
 * Turn a declared topology into the spec the providers already take.
 *
 * The two describe the same thing; only the route differs. Defaults live here
 * rather than in the declaration so a request that omits a field gets the same
 * answer whichever way it arrived.
 */
export function specFromTopology(topology: EnvironmentTopology): MultiNodePromptSpec {
  const extraEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(topology.extra_env ?? {})) {
    if (!RESERVED_EXTRA_ENV.has(name)) extraEnv[name] = value;
  }
  return {
    nodes: topology.nodes,
    gpusPerNode: topology.gpus_per_node ?? DEFAULT_GPUS_PER_NODE,
    cpusPerNode: topology.cpus_per_node ?? DEFAULT_CPUS_PER_NODE,
    memPerNodeGiB: topology.mem_per_node_gib ?? DEFAULT_MEM_PER_NODE_GIB,
    backend: topology.backend,
    image: (topology.image ?? "").trim(),
    extraEnv,
    model: (topology.model ?? "").trim(),
    framework: topology.framework ?? DEFAULT_FRAMEWORK,
    kvTransferBackend: topology.pd_transfer_backend ?? defaultKvTransferBackend(topology.backend),
    pdMode: topology.pd_mode ?? defaultPdMode(topology.backend),
    pdPrefillNodes: topology.pd_prefill_nodes ?? 0,
    pdDecodeNodes: topology.pd_decode_nodes ?? 0,
    pdPrefillTp: topology.pd_prefill_tp ?? 0,
    pdDecodeTp: topology.pd_decode_tp ?? 0,
    serverArgs: (topology.server_args ?? "").trim(),
    pdPrefillExtraArgs: (topology.pd_prefill_extra_args ?? "").trim(),
    pdDecodeExtraArgs: (topology.pd_decode_extra_args ?? "").trim(),
    pdIbDevice: (topology.pd_ib_device ?? "").trim(),
  };
}

/**
 * The topology a request asks for, from wherever it declared it.
 *
 * The body wins when present, and an invalid body is refused rather than
 * quietly falling through to the prompt: a caller who declared a topology and
 * got it wrong wants to hear so, and reading their prompt instead would answer
 * a question they did not ask. A request with no declaration is read the old
 * way, which is every caller that has not moved yet.
 *
 * @throws when `topology` is present and does not validate.
 */
/**
 * Code for a declaration the validator refused, taken from the same shape
 * rules the builder uses. Absent when the refusal is not one of those.
 */
function declaredFailureCode(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const backend = typeof body.backend === "string" ? body.backend : "";
  if (!(TOPOLOGY_BACKENDS as readonly string[]).includes(backend)) return null;
  const known = backend as TopologyBackend;
  if (backendRequiresModel(known) && !String(body.model ?? "").trim()) {
    return known === "infera" ? "infera_model_missing" : "mn_model_missing";
  }
  if (!backendRequiresDisaggregatedPd(known)) return null;
  const problems = pdClusterProblems({
    backend: known,
    pdMode: typeof body.pd_mode === "string" ? body.pd_mode : undefined,
    nodes: typeof body.nodes === "number" ? body.nodes : 0,
    gpusPerNode: typeof body.gpus_per_node === "number" ? body.gpus_per_node : undefined,
    pdPrefillNodes: typeof body.pd_prefill_nodes === "number" ? body.pd_prefill_nodes : undefined,
    pdDecodeNodes: typeof body.pd_decode_nodes === "number" ? body.pd_decode_nodes : undefined,
    pdPrefillTp: typeof body.pd_prefill_tp === "number" ? body.pd_prefill_tp : undefined,
    pdDecodeTp: typeof body.pd_decode_tp === "number" ? body.pd_decode_tp : undefined,
  });
  return problems.length ? "mn_config_invalid" : null;
}

export function resolveTopology(
  request: { prompt?: string; topology?: unknown },
): MultiNodePromptSpec | null {
  if (request.topology !== undefined && request.topology !== null) {
    const checked = validateTopology(request.topology);
    if (!checked.ok) {
      const message = `invalid topology: ${checked.errors.join("; ")}`;
      const code = declaredFailureCode(request.topology);
      throw code ? new SandboxFailure(code, message) : new Error(message);
    }
    return checked.value.nodes >= 2 ? specFromTopology(checked.value) : null;
  }
  return parseMultiNodePromptFlags(request.prompt ?? "");
}

/**
 * True when the task should provision a multi-node GPU cluster before Hands.
 *
 * Reads the declared topology when the request carries one, and otherwise the
 * Hyperloom `optimize` flags in the prompt (`--nodes >= 2` plus an explicit
 * `--mn-backend`). `resources`/`resource` is not consulted either way: it sizes
 * the Hands sandbox and nothing else.
 *
 * Never throws, so a caller can ask the question without handling a validation
 * failure -- a declaration that does not validate is multi-node by intent, and
 * saying so here routes it to `resolveTopology`, which reports why.
 *
 * That last part is why this validates rather than reading `nodes` directly.
 * A tolerant count answers 1 for anything it cannot parse, so a misspelled
 * `node` or a quoted `"64"` would be called single-node, never reach the
 * resolver, and run on one GPU without a word -- the silent single-node run
 * the declaration was introduced to remove. Admission validates the same
 * request today, so nothing reaches here invalid; that is a property of the
 * caller rather than of this function, and `claw_tasks.topology` is already
 * reserved for a path that has no admission check yet.
 */
export function isMultiNodeRequest(request: { prompt?: string; topology?: unknown }): boolean {
  if (request.topology !== undefined && request.topology !== null) {
    const checked = validateTopology(request.topology);
    return checked.ok ? checked.value.nodes >= 2 : true;
  }
  return parseMultiNodePromptFlags(request.prompt ?? "") !== null;
}
