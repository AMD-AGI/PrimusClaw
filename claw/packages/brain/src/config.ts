// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import "dotenv/config";
import {
  DEFAULT_BRAIN_REGISTRY_TTL_MS,
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_TTL_MS,
  DEFAULT_TASK_MAX_ACK_PENDING,
  DEFAULT_TASK_MAX_DELIVER,
  MIN_RENEWAL_INTERVAL_MS,
  resolveTaskDeliveryBudget,
  RUN_LEASE_HEARTBEATS_PER_TTL,
  TASK_LOCK_NAK_BASE_MS,
  TASK_LOCK_NAK_CEILING_NS,
} from "@claw/protocol";
import { readIntSetting, type IntSettingBounds } from "@claw/utils";

// Re-exported so the budget and the poison threshold derived from it stay
// reachable from one import, the way they were when this file owned both.
export { resolveTaskDeliveryBudget };

/**
 * Read a setting, treating blank the same as unset.
 *
 * `||` rather than `??`, because a key is far more often blank than absent:
 * `start-all.sh` does `set -a; source .env`, so every entry `.env.example`
 * deliberately leaves empty is *exported as ""*. Under `??` the fallback only
 * covers `undefined`, so those arrive as empty strings and the documented
 * defaults never apply -- a blank `BRAIN_CHECKPOINTS_BUCKET` opened a KV
 * handle on a bucket named "" and killed the process at startup, while
 * `.env.example` promised the default.
 *
 * It is also what the siblings below already do: `envBool` returns its
 * fallback on a blank value, and `envInt` goes through `readIntSetting`, which
 * calls blank "an absent setting". The cost is that no setting here can be
 * configured *to* the empty string; none wants to be, and the alternative is
 * the three helpers disagreeing about what an empty `.env` line means.
 */
function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

/**
 * Settings that were set and then ignored, for startup to report.
 *
 * Same reasoning as the API's copy: a refused value means somebody configured
 * something and the process is running on a default instead, which is worth
 * more noise than a setting nobody touched. Constants are evaluated before
 * there is a logger, so the reasons wait here for `validateStartupConfig()`.
 */
const settingProblems: string[] = [];

/** Why any configured value was refused, in the operator's terms. */
export function envSettingProblems(): readonly string[] {
  return settingProblems;
}

function envInt(key: string, fallback: number, bounds?: IntSettingBounds): number {
  const setting = readIntSetting(process.env[key], bounds);
  if (setting === null) return fallback;
  if ("problem" in setting) {
    settingProblems.push(`${key}=${env(key)} ${setting.problem}; using ${fallback}`);
    return fallback;
  }
  return setting.value;
}
function envBool(key: string, fallback = false): boolean {
  const v = env(key).toLowerCase();
  if (!v) return fallback;
  return ["true", "1", "yes"].includes(v);
}

// --- Deploy mode ---
// "safe": existing SaFE deployment (safe-workload provider + SaFE auth).
// "kubernetes": standalone run (agent-sandbox provider + BYOK, ENABLE_AUTH off).
export type DeployMode = "safe" | "kubernetes";
export const CLAW_DEPLOY_MODE: DeployMode =
  env("CLAW_DEPLOY_MODE", "safe") === "kubernetes" ? "kubernetes" : "safe";
export function isKubernetesMode(): boolean {
  return CLAW_DEPLOY_MODE === "kubernetes";
}

// --- Hands MCP ---
export const HANDS_MCP_URL = env("HANDS_MCP_URL");
// Shared secret used only for internal auth paths.
export const AUTH_INTERNAL_TOKEN = env("AUTH_INTERNAL_TOKEN");

/**
 * Chat doorbell dispatch. The API owns this flag. Brain still accepts the
 * same env so a mixed chart can set both; claim-next is enabled by
 * INTERNAL_BACKEND_URL so leftover doorbell rows drain after the flag is off.
 */
export const RUN_DOORBELL_DISPATCH = envBool("RUN_DOORBELL_DISPATCH", false);

/** In-cluster API base used for claim-next when this pod is idle. */
export const INTERNAL_BACKEND_URL = env("INTERNAL_BACKEND_URL");

/** How often an idle, admissible pod asks for the next queued run. */
export const CLAIM_NEXT_IDLE_MS = envInt("CLAIM_NEXT_IDLE_MS", 2_000, { min: 250 });

// --- LLM ---
export const ANTHROPIC_BASE_URL = env("ANTHROPIC_BASE_URL");
export const ANTHROPIC_API_KEY = env("ANTHROPIC_AUTH_TOKEN") || env("ANTHROPIC_API_KEY");
// NOTE: OPENAI_BASE_URL/OPENAI_API_KEY below exist primarily to be forwarded
// into the sandbox env (BYOK agent-sandbox path + SaFE apiKey passthrough,
// see index.ts) so user code/CLIs running inside Hands can authenticate
// against an OpenAI-compatible endpoint. OPENAI_BASE_URL's fallback to
// ANTHROPIC_BASE_URL is intentional for THAT purpose. LLM_API_STYLE below
// uses its explicit env value first and only inspects raw base URL settings
// when that override is absent.
export const OPENAI_BASE_URL = env("OPENAI_BASE_URL") || env("ANTHROPIC_BASE_URL");
export const OPENAI_API_KEY = env("OPENAI_API_KEY") || env("ANTHROPIC_AUTH_TOKEN");
export const DEFAULT_MODEL = env("DEFAULT_MODEL", "claude-sonnet-4-20250514");

// --- LLM API style (Brain's own inference calls; see packages/brain/src/llm/) ---
export type LlmApiStyle = "anthropic" | "openai";

/** Resolve the deployment-wide LLM wire protocol with an explicit override. */
function resolveLlmApiStyle(): LlmApiStyle {
  const configured = env("LLM_API_STYLE");
  if (configured === "anthropic" || configured === "openai") return configured;
  if (configured) {
    throw new Error("LLM_API_STYLE must be either \"anthropic\" or \"openai\"");
  }
  return ANTHROPIC_BASE_URL ? "anthropic" : (env("OPENAI_BASE_URL") ? "openai" : "anthropic");
}

export const LLM_API_STYLE: LlmApiStyle = resolveLlmApiStyle();

// --- LLM key source ---
// "virtualKey" preserves the existing behavior. "platformKey" is proxy mode:
// Engines and kubernetes sandbox env use platform_key as the LLM API key.
export type LlmKeySource = "virtualKey" | "platformKey";
export const LLM_KEY_SOURCE: LlmKeySource =
  env("LLM_KEY_SOURCE", "virtualKey") === "platformKey" ? "platformKey" : "virtualKey";
export function usePlatformKeyForLlm(): boolean {
  return LLM_KEY_SOURCE === "platformKey";
}

// --- SaFE Platform ---
export const SAFE_API_URL = env("SAFE_API_URL");
export const TOOLS_API_URL = `${SAFE_API_URL}/claw-api/v1/tools`;

// --- Sandbox ---
/** Optional in-cluster agent-sandbox-router base (no path suffix). When set, SafeWorkloadProvider.exec uses this + `/v1/namespaces/...`; when empty, uses `${SAFE_API_URL}/sandbox` + same path (public ingress). */
export const SANDBOX_ROUTER_URL = env("SANDBOX_ROUTER_URL", "");
export const SANDBOX_NAMESPACE = env("SANDBOX_NAMESPACE", "default");
export const SANDBOX_CLUSTER_ID = env("SANDBOX_CLUSTER_ID");

// --- agent-sandbox provider (kubernetes mode) ---
// Router base URL of PrimusClaw/Sandbox, e.g.
// http://agent-sandbox-router.agent-sandbox-system.svc.cluster.local:8080
export const AGENT_SANDBOX_ROUTER_URL = env("AGENT_SANDBOX_ROUTER_URL", "");
export const AGENT_SANDBOX_NAMESPACE = env("AGENT_SANDBOX_NAMESPACE", "default");
export const AGENT_SANDBOX_TEMPLATE = env("AGENT_SANDBOX_TEMPLATE", "primus-claw-hands");
// Base CodeInterpreter template file (ConfigMap-mounted YAML). renderTemplate
// clones it and overrides only fromImage/resources/gpu/name. Empty or unreadable
// → falls back to a minimal inline skeleton.
export const AGENT_SANDBOX_TEMPLATE_FILE = env("AGENT_SANDBOX_TEMPLATE_FILE", "");
/**
 * Pre-warmed sandbox pods the platform keeps ready. Applied by renderTemplate to
 * every rendered template, whichever base it was cloned from — the value used to
 * be a literal inside the inline fallback skeleton only, so a deployment that
 * mounted its own base ConfigMap had no way to reach it at all.
 *
 * Safe to raise now. It was pinned at 0 because the per-request environment
 * travelled only in the pod spec, and a pooled pod's spec is fixed before
 * anyone knows whose request it will take: the platform's claim path adopts a
 * running pod and can patch only labels, annotations and lifecycle onto it, so
 * `user_env`, `session_env`, the system env and the LLM keys were dropped.
 * Nothing failed visibly -- Hands came up, and the user's commands simply ran
 * without the environment they had configured. Bootstrap now hands that
 * environment over itself, after the request is known, and verifies the Hands
 * it started actually consumed it (see sandbox/bootstrap.ts), so a pooled pod
 * ends up with the same environment a purpose-built one would have.
 *
 * Raising it is still a cost decision rather than a free win: pooled pods are
 * real pods, idle, and the pool is per rendered template -- so a deployment
 * with many distinct images or resource shapes keeps a pool for each.
 */
export const AGENT_SANDBOX_WARM_POOL_SIZE = Math.max(
  0,
  envInt("AGENT_SANDBOX_WARM_POOL_SIZE", 0),
);

/**
 * Idle timeout for sandboxes this Brain creates, as a Go duration ("2h", "90m").
 *
 * The platform deletes a Sandbox once `lastActivity + timeout` passes, and
 * `lastActivity` only moves for traffic through the Router -- a request in
 * flight, or the Brain keepalive exec. Work running *inside* the pod does not
 * move it, so a sandbox busy with a long computation looks exactly like an
 * abandoned one. Brain also stops the keepalive the moment a task reaches a
 * terminal state (see stopKeepaliveAfterTask), which is right when the sandbox
 * is only a warm cache for the next message -- and wrong when something the
 * task started is still running in there. That combination reclaims a working
 * sandbox 15 minutes after the agent turn ends.
 *
 * The platform has always taken a per-sandbox override
 * (`runtime.agent-sandbox.io/idle-timeout`, no upper bound, with
 * maxSessionDuration as the real backstop) and the Workload Manager writes it
 * from the CodeInterpreter spec -- Brain simply never set the field, so every
 * sandbox took the controller default of 15m no matter what it was for.
 *
 * Empty means "leave whatever the base template says", which is what every
 * deployment gets until it opts in: a mounted ConfigMap that sets its own
 * sessionTimeout keeps it, and the inline skeleton keeps its 15m. Raising this
 * costs held nodes -- the sandbox survives that much longer after everyone has
 * stopped asking it for anything -- so prefer the per-request
 * `SandboxCreateParams.sessionTimeout` for the one workload that needs it over
 * moving the floor for all of them.
 */
/**
 * A Go duration in whole nanoseconds, or null if it is not one worth sending.
 *
 * Three ways a well-formed string is still not a value the Workload Manager will
 * use, and it refuses all three the same way -- silently, leaving the default in
 * place while the operator believes they configured something:
 *
 *   `0s`       parses, but the override is only applied when positive
 *   `0.1ns`    parses to zero, because a Go duration is whole nanoseconds
 *   `1e6h`     overflows int64 and does not parse at all
 *
 * Nanoseconds rather than milliseconds so the truncation happens here, in the
 * same units and the same direction Go does it.
 */
const GO_DURATION_NS: Record<string, number> = {
  ns: 1, us: 1e3, "\u00b5s": 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12,
};
const GO_DURATION_MAX_NS = 2 ** 63 - 1;

export function goDurationNs(value: string): number | null {
  if (!/^(\d+(\.\d+)?(ns|us|\u00b5s|ms|s|m|h))+$/.test(value)) return null;
  let total = 0;
  for (const [, n, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|\u00b5s|ms|s|m|h)/g)) {
    total += Number(n) * GO_DURATION_NS[unit];
  }
  const whole = Math.trunc(total);
  if (!Number.isFinite(whole) || whole <= 0 || whole > GO_DURATION_MAX_NS) return null;
  return whole;
}

function resolveAgentSandboxSessionTimeout(): string {
  const configured = env("AGENT_SANDBOX_SESSION_TIMEOUT");
  if (!configured) return "";
  if (goDurationNs(configured) === null) {
    settingProblems.push(
      `AGENT_SANDBOX_SESSION_TIMEOUT=${configured} is not a positive Go duration `
        + `(e.g. "90m", "2h30m"); leaving the template's own value`,
    );
    return "";
  }
  return configured;
}
export const AGENT_SANDBOX_SESSION_TIMEOUT = resolveAgentSandboxSessionTimeout();

/**
 * Absolute lifetime for sandboxes this Brain creates, as a Go duration.
 *
 * The other end of the same clamp as AGENT_SANDBOX_SESSION_TIMEOUT, and the one
 * nothing can talk its way out of: the idle timeout is a deadline the sandbox
 * pushes back every time something touches it, while this one is written onto
 * the CR as an absolute ShutdownTime and enforced by a controller that reads no
 * store and takes no heartbeat. Keeping a sandbox alive past it is not possible
 * from Brain's side at all -- not by pinging, not by holding work open.
 *
 * The platform puts no ceiling on it ("no hard cap -- longer values pass through
 * as-is") and takes it per template or per request, so the 24h every sandbox
 * gets here is not a platform limit. It is a literal in this file's inline
 * fallback skeleton, which is to say it was unreachable for a deployment that
 * mounted its own base ConfigMap and unreachable per request for anyone --
 * exactly the gap AGENT_SANDBOX_SESSION_TIMEOUT closed for the idle side, left
 * open on the line below it.
 *
 * Empty leaves whatever the base template says, so nothing changes until a
 * deployment opts in. Raise it only for work that genuinely runs that long: it
 * is a ceiling on leaked sandboxes too, and the thing that bounds what a lost
 * activity record can cost.
 */
function resolveAgentSandboxMaxSessionDuration(): string {
  const configured = env("AGENT_SANDBOX_MAX_SESSION_DURATION");
  if (!configured) return "";
  if (goDurationNs(configured) === null) {
    settingProblems.push(
      `AGENT_SANDBOX_MAX_SESSION_DURATION=${configured} is not a positive Go `
        + `duration (e.g. "48h", "36h30m"); leaving the template's own value`,
    );
    return "";
  }
  return configured;
}
export const AGENT_SANDBOX_MAX_SESSION_DURATION = resolveAgentSandboxMaxSessionDuration();
export const MULTI_NODE_DEFAULT_TIMEOUT_SECONDS = envInt(
  "MULTI_NODE_DEFAULT_TIMEOUT_SECONDS",
  24 * 60 * 60,
);
export const SANDBOX_DEFAULT_TIMEOUT_SECONDS = envInt(
  "SANDBOX_DEFAULT_TIMEOUT_SECONDS",
  24 * 60 * 60,
);
// SaFE workload queue priority (higher = scheduled first). The neutral public
// default avoids claiming a platform's highest rank; deployments may opt in.
export const SANDBOX_WORKLOAD_PRIORITY = envInt("SANDBOX_WORKLOAD_PRIORITY", 0);
export const CLAW_DEPLOY_ROOT = env("CLAW_DEPLOY_ROOT", "");
// POD_NAMESPACE is injected by the K8s downward API (brain-deployment.yaml).
// Used to namespace shared-storage assets so dev/prod can share the same
// CLAW_DEPLOY_ROOT root mount without overwriting each other's hands-binary.
// Resolves to "${CLAW_DEPLOY_ROOT}/<NAMESPACE>/hands-binary" in cluster, and
// "${CLAW_DEPLOY_ROOT}/hands-binary" when POD_NAMESPACE is empty (local dev).
export const POD_NAMESPACE = env("POD_NAMESPACE", "");
export const LOCAL_MODE_HANDS_BINARY = CLAW_DEPLOY_ROOT
  ? POD_NAMESPACE
    ? `${CLAW_DEPLOY_ROOT}/${POD_NAMESPACE}/hands-binary`
    : `${CLAW_DEPLOY_ROOT}/hands-binary`
  : "";

// --- Brain-bundled asset fallback (when CLAW_DEPLOY_ROOT is unavailable) ---
// Sandbox bootstrap downloads hands-binary from this URL when shared storage
// is unavailable. Defaults to the in-cluster brain ClusterIP service so the
// request load-balances across all brain pods (rolling-update safe; no pod-IP
// staleness). Override BRAIN_HTTP_URL for non-K8s setups (e.g. local dev).
export const BRAIN_HTTP_URL = env(
  "BRAIN_HTTP_URL",
  POD_NAMESPACE
    ? `http://primus-claw-brain.${POD_NAMESPACE}.svc.cluster.local:${envInt("EXECUTOR_PORT", 8100)}`
    : "",
);
export const BRAIN_BUNDLED_HANDS_BINARY = env("BRAIN_BUNDLED_HANDS_BINARY", "/app/hands-binary");

// --- Session workspace root ---
// Engines build per-session paths under this root (e.g.
// `${BRAIN_SESSION_ROOT}/users/<uid>/sessions/<sid>`). Defaults to
// "/workspace", matching the SaFE sandbox layout where that path is the
// only writable mount. For local dev (where Brain runs on the host and
// /workspace is not writable), point at a local path, e.g.
// BRAIN_SESSION_ROOT=/tmp/claw-workspace/brain.
export const BRAIN_SESSION_ROOT = env("BRAIN_SESSION_ROOT", "/workspace");

// --- S3 ---
export const S3_ACCESS_KEY = env("S3_ACCESS_KEY");
export const S3_SECRET_KEY = env("S3_SECRET_KEY");
export const S3_BUCKET = env("S3_BUCKET", "claw");
export const S3_PLUGINS_BUCKET = env("S3_PLUGINS_BUCKET", "plugins");
export const S3_REGION = env("S3_REGION", "us");
export const S3_ENDPOINT = env("S3_ENDPOINT");
// S3_API_ENDPOINT: override that forces S3 SDK traffic at a specific S3 API
// endpoint. Falls back to S3_ENDPOINT when unset. Mirrors the api-side
// config so brain's plugin download path can opt into the correct API
// host/port when S3_ENDPOINT was (mis)configured at a non-API URL (e.g.
// the MinIO Console port) without mutating S3_ENDPOINT.
export const S3_API_ENDPOINT = env("S3_API_ENDPOINT") || S3_ENDPOINT;
export const S3_FORCE_PATH_STYLE = envBool("S3_FORCE_PATH_STYLE", true);
/**
 * Ceiling on deletions per prune round -- see prunePlan for why a large stale
 * set is trimmed rather than refused. A value below one is refused and reported
 * at startup, and the default is used instead, so that neither a mistyped value
 * nor a deliberate zero resolves to a ceiling that prunes nothing for ever. A
 * zero reads as "switch the prune off", which is not what a ceiling is -- and
 * the sync cannot tell that from a prune with nothing to do, so what it produces
 * is objects accumulating in silence.
 */
export const S3_PRUNE_MAX_OBJECTS = envInt("S3_PRUNE_MAX_OBJECTS", 5000, { min: 1 });

// --- NATS ---
export const NATS_URL = env("NATS_URL", "nats://localhost:4222");
// NATS account-based isolation: each dev/env connects with its own NATS
// account credentials; stream/subject names are stable.
export const NATS_USER = env("NATS_USER");
export const NATS_PASSWORD = env("NATS_PASSWORD");

// --- Task consumer redelivery budget ---
// Resolved from @claw/protocol, which the API resolves from too. These are the
// values brain *expects* the shared durable to carry, not values brain writes:
// it verifies the durable against them on start and refuses to run below them.
// See task-consumer.ts for why one writer and N verifiers, and why the
// resolution cannot be mirrored per package.
const taskDeliveryBudget = resolveTaskDeliveryBudget(
  envInt("TASK_MAX_DELIVER", DEFAULT_TASK_MAX_DELIVER),
);
export const TASK_MAX_DELIVER = taskDeliveryBudget.maxDeliver;
export const TASK_POISON_DELIVERY_COUNT = taskDeliveryBudget.poisonDeliveryCount;

/**
 * Ceiling on messages delivered but not yet acked, for the whole `brain-workers`
 * durable rather than per pod.
 *
 * This bounds how many deliveries are outstanding, not how many tasks run.
 * Execution is capped per pod by tasks/execution-gate.ts, which holds the
 * delivery loop at MAX_CONCURRENT; this value has to leave room above that cap,
 * because `consume({ max_messages })` is a prefetch window that refills when a
 * message *arrives* rather than when one finishes, so a pod can hold delivered
 * messages it is not yet running.
 *
 * It has to cover two sets at once, and the old MAX_CONCURRENT * 3 left no
 * room for the second:
 *
 *   - Tasks executing across every replica. The 3 was the replica count, so
 *     that expression was exactly brain.replicas * MAX_CONCURRENT -- a
 *     deliberate fleet execution cap carrying zero slack.
 *   - Tasks nak'd and waiting on a lock. NATS counts a nak'd message as
 *     outstanding for the whole redelivery delay, now up to
 *     TASK_LOCK_NAK_MAX_MS instead of the old flat 3s, so a handful of tasks
 *     queued behind long-running siblings would exhaust the ceiling and stop
 *     delivery to every replica at once -- trading one dropped task for a
 *     fleet-wide stall.
 *
 * The waiting set is dominated by DAG fan-out, since siblings under one
 * dag_root_task_id share a lock key by design; chat contention is normally
 * only the seconds between exec_complete and the lock release, because a
 * message arriving while its session is running is parked in
 * claw_pending_messages by the API and never reaches this stream.
 *
 * Tunable rather than fixed because the right value follows the deployment's
 * replica count and widest fan-out, neither of which this process can see.
 * Raise it before widening either: undersized, the failure is a fleet-wide
 * stall. Oversized is now bounded rather than unbounded — the spare slots buy
 * prefetch and nak backoff room, not extra sandboxes, since the per-pod gate
 * decides what actually runs.
 */
export const TASK_MAX_ACK_PENDING = envInt(
  "TASK_MAX_ACK_PENDING",
  DEFAULT_TASK_MAX_ACK_PENDING,
);

// Backoff for redeliveries caused by lock contention rather than by failure:
// the task is healthy, another handler simply holds its lock. Each such
// redelivery still spends one of TASK_MAX_DELIVER, so the old flat 3s nak
// burned the entire budget in ~30s and dropped tasks queued behind a sibling
// that had hours left to run. Doubling from base to ceiling spreads the
// budget the poison guard actually allows (deliveries 1..TASK_POISON_DELIVERY_COUNT-1)
// over ~80min, or ~60min once jitter is at its floor -- sized against the queue
// the workspace gate creates, where several runs on one session wait on one
// directory rather than running at once.
//
// Fixed rather than configurable: a base of 0 would nak immediately and burn
// the whole redelivery budget in milliseconds, which is precisely the silent
// drop this backoff exists to prevent. There is no operational reason to tune
// these independently of TASK_MAX_DELIVER, and making them env-driven only
// created a way to switch the mechanism off by accident.
//
// Both ends of the curve come from the protocol package rather than being
// written here, because two other numbers are computed from them: the stream's
// retention, which has to keep a message long enough to survive every
// delivery's ack window plus every nak's backoff, and the point at which a
// redelivery blocked by a dead worker's lock can first take the run over, which
// is what the lease reaper has to stay behind. Either one raised here alone
// would silently invalidate a derivation made elsewhere.
export { TASK_LOCK_NAK_BASE_MS };
export const TASK_LOCK_NAK_MAX_MS = TASK_LOCK_NAK_CEILING_NS / 1_000_000;

// --- Identity ---
export const BRAIN_ID = env("BRAIN_ID", "brain-default");
// Brain image version tag, injected by Deployment env BRAIN_VERSION.
// Used for version-aware cooperative drain: Brain compares own version
// against brain.min_version in NATS KV and self-drains if outdated.
export const BRAIN_VERSION = env("BRAIN_VERSION", "");
// TTL for task checkpoint KV entries (ms) in the BRAIN_CHECKPOINTS bucket
// (Plan Y v2). Sized at 24h to cover: the window a message can still be
// redelivered into (resolveTaskStreamMaxAgeNs, which derives it from the
// delivery budget and is not restated here because retuning the budget moves
// it), brain rolling-update window (terminationGracePeriodSeconds=300s +
// new pod startup), plus a wide safety margin for incident-driven manual
// redelivery. The bucket itself enforces max_age=TTL at the stream level
// so expired payloads are garbage-collected automatically; the writer
// still checks code-side `checkpointed_at` to guard against attaching
// stale state during edge cases (drift between NATS and brain clocks).
export const CHECKPOINT_TTL_MS = envInt("CHECKPOINT_TTL_MS", 24 * 60 * 60 * 1000);
export const SESSION_ID = env("SESSION_ID");
export const USER_ID = env("USER_ID", "default");

// --- Brain Checkpoint (Plan Y v2) ---
// KV bucket names; isolated by purpose:
//   BRAIN_REGISTRY    short-lived coordination keys (lock.<sid>, hands.<sid>,
//                     deleted.<sid>), 5min TTL, replicas=3.
//   BRAIN_CHECKPOINTS task state payloads, 24h TTL, replicas=3, 16MB max
//                     value, s2 compression.
// Names are env-overridable for parallel test environments; the api package
// is the authority that actually creates/updates these buckets (see
// api/src/infra/nats.ts ensureKvBucket). brain only reads/writes via KV handle.
export const BRAIN_REGISTRY_BUCKET = env("BRAIN_REGISTRY_BUCKET", "BRAIN_REGISTRY");
export const BRAIN_CHECKPOINTS_BUCKET = env("BRAIN_CHECKPOINTS_BUCKET", "BRAIN_CHECKPOINTS");
// System-level env distribution bucket. Mirrors api/src/infra/nats.ts SYSTEM_ENV_BUCKET.
// API publishes the decrypted global env map here; brain attaches read-only and
// watches it (brain never holds the master key). See system-env-design.md §5.2.
export const SYSTEM_ENV_BUCKET = env("SYSTEM_ENV_BUCKET", "SYSTEM_ENV");

// Per-bucket KV stream config. The registry's TTL comes from the protocol
// package because it is not only a bucket setting: `lock.<key>` lives in this
// bucket, so this is also how long a dead worker's claim on a session outlives
// it, and the lease reaper on the API side derives its own grace from that. The
// two packages read the same default and the same env var, which is what stops
// one of them being tuned into disagreeing with the other.
//
// The replica counts fall back to NATS_REPLICAS, the API package's variable of
// the same name, so one setting covers both processes: a single-node dev server
// otherwise needs one variable per bucket, and JetStream refuses replicas>1 in
// non-clustered mode (err 10074) for every one that gets missed.
export const NATS_REPLICAS = envInt("NATS_REPLICAS", 3, { min: 1 });
export const BRAIN_REGISTRY_REPLICAS = envInt("BRAIN_REGISTRY_REPLICAS", NATS_REPLICAS);
export const BRAIN_REGISTRY_TTL_MS = envInt(
  "BRAIN_REGISTRY_TTL_MS",
  DEFAULT_BRAIN_REGISTRY_TTL_MS,
);

/**
 * How often a running task proves it still holds its `lock.<key>`.
 *
 * Named here rather than left as a literal in the keepalive that applies it,
 * because task-lock reads it too: how long a run may go without a successful
 * renewal before standing down is the bucket TTL less one of these, and the two
 * numbers have to come from the same place to stay one relation.
 *
 * Bounded below because this is an interval and not a switch: an operator
 * reading it as "off" gets a pod that spends itself on NATS instead of one that
 * stops renewing. How far above the floor it must stay to keep the lock
 * exclusive is a relation with the bucket TTL, checked at startup by
 * validateStartupConfig.
 */
export const LOCK_REFRESH_INTERVAL_MS = envInt(
  "LOCK_REFRESH_INTERVAL_MS",
  10_000,
  { min: MIN_RENEWAL_INTERVAL_MS },
);

/**
 * Deletion tombstones live apart from the registry because the two want
 * opposite TTLs: `lock.<key>` should expire quickly so a dead worker's claim is
 * released, while a tombstone has to outlive everything that could still ask
 * about the session it marks -- a task the queue can still redeliver, and every
 * event still held on the API's event stream. API owns the bucket's configuration;
 * this is the name brain attaches to, and reading an absent bucket is not an
 * error here -- the registry copy still answers during a rolling upgrade.
 *
 * A literal rather than an override, mirroring api/src/infra/nats.ts the way the other
 * bucket names do. An override could only ever point brain at a bucket the API
 * does not create or write, and brain would then fall back to the registry copy
 * and its five minutes -- reopening the window this bucket exists to close, with
 * nothing failing to say so.
 */
export const BRAIN_TOMBSTONES_BUCKET = "BRAIN_TOMBSTONES";

/**
 * What decides whether two runs may proceed at once.
 *
 * "workspace" keys the gate on the files the run declares it writes, which is
 * the question that actually matters. "session" is the historical proxy: a
 * chat run serialised per session, a DAG node per graph root, and the two
 * schemes did not see each other -- so a chat turn and a DAG task on one
 * session overlapped, as did two DAG roots over one session, both of them
 * writing one directory.
 *
 * Keyed on the workspace, those cases queue. That is a throughput change as
 * well as a correctness one, which is why the old behaviour is still one
 * value away.
 *
 * Anything other than "session" is the new behaviour, so a typo cannot silently
 * restore the overlap this fixes. The raw value is kept so startup can say the
 * setting was not understood.
 */
export type RunGateKey = "workspace" | "session";
export const RUN_GATE_KEY_CONFIGURED = env("RUN_GATE_KEY", "workspace");
export const RUN_GATE_KEY: RunGateKey =
  RUN_GATE_KEY_CONFIGURED === "session" ? "session" : "workspace";

/**
 * How often a run renews its row's lease, and how long each renewal is good
 * for. The ratio matters more than either number: at three heartbeats per
 * lease, two can be lost to a slow API or a GC pause without the run being
 * declared dead, and a worker that really is gone is noticed within the TTL
 * rather than at the end of the queue's redelivery budget.
 *
 * The defaults live in the protocol package because the API derives the reaper's
 * grace from the lease it is judging: a TTL only this process can see is a TTL
 * the reaper can disagree with, and it disagrees by closing live runs.
 *
 * Neither may be small. A heartbeat under a round trip is a lease POST issued
 * before the last one answered, for every run on the pod, and a TTL that short
 * has expired by about the time the row is written. Zero is how an operator
 * reaches either state on purpose, but neither failure needs zero, and the ratio
 * between them that validateStartupConfig checks stops neither. A heartbeat of
 * a millisecond it cannot see at all: three of those fit inside any TTL there
 * is. A TTL that small it does see, since three heartbeats of any ordinary size
 * do not fit inside one -- but seeing is all it does. It logs, the value takes
 * effect, every lease this pod writes carries it, and the API reads the same
 * variable to derive how long after a lapse its reaper may call the run dead.
 * So the floor lives on each setting, where a refused value is reported and the
 * default is kept: the heartbeat gets the renewal floor above, and the TTL gets
 * that floor times the renewals it has to cover -- the smallest TTL worth
 * writing is the one a lease renewed as fast as it may be renewed can still
 * prove liveness inside.
 */
export const RUN_LEASE_HEARTBEAT_MS = envInt(
  "RUN_LEASE_HEARTBEAT_MS",
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  { min: MIN_RENEWAL_INTERVAL_MS },
);
export const RUN_LEASE_TTL_MS = envInt(
  "RUN_LEASE_TTL_MS",
  DEFAULT_RUN_LEASE_TTL_MS,
  { min: MIN_RENEWAL_INTERVAL_MS * RUN_LEASE_HEARTBEATS_PER_TTL },
);

/**
 * Defer sandbox creation until a tool asks for one. Most chat turns answer
 * from the conversation and never touch a file or run a command, and paying a
 * pod start for those is the single largest fixed cost in a short session.
 * Runs that are about the sandbox — script mode, multi-node, anything resuming
 * from a checkpoint — still provision up front regardless of this setting.
 * Set to 0 to go back to opening one for every run, which is the behaviour to
 * fall back to if a sandbox-dependent path turns out to have been missed.
 */
export const BRAIN_LAZY_SANDBOX = envBool("BRAIN_LAZY_SANDBOX", true);

// Post-task sandbox reuse window. When a task finishes we stop pinging the pod
// (so the control-plane sandbox-idle-gc-controller reclaims it after its own
// ~15min idle timeout — no extra GPU cost) but keep the `hands.<sid>` KV entry
// marked keepalive:false so the next user message within this window reuses the
// still-alive pod without a cold start. Completes the intent of commit a7dffbf6,
// which was broken by the eager kv.delete on task completion. Keep this <= the
// control-plane idle timeout so the handle expires around when the pod dies.
export const SANDBOX_IDLE_REUSE_MS = envInt("SANDBOX_IDLE_REUSE_MS", 15 * 60 * 1000);
// Mirror of CHECKPOINT_TTL_MS; kept as a distinct symbol so call-sites that
// attach to the BRAIN_CHECKPOINTS bucket read the bucket-scoped constant
// (matches BRAIN_REGISTRY_TTL_MS naming).
export const BRAIN_CHECKPOINTS_TTL_MS = envInt(
  "BRAIN_CHECKPOINTS_TTL_MS",
  24 * 60 * 60 * 1000,
);
export const BRAIN_CHECKPOINTS_REPLICAS = envInt("BRAIN_CHECKPOINTS_REPLICAS", NATS_REPLICAS);
// DAG_HANDLES is the one bucket brain creates itself, and it was opened with
// `js.views.kv(BUCKET)` and no options, so it took the JetStream default of a
// single replica and kept it: one server owning the handles that every
// `sandbox.use` resolves through. The same single point of failure that took
// task dispatch down on 2026-09-01, one bucket over.
export const DAG_HANDLES_REPLICAS = envInt("DAG_HANDLES_REPLICAS", NATS_REPLICAS, { min: 1 });
export const BRAIN_CHECKPOINTS_MAX_VALUE_BYTES = envInt(
  "BRAIN_CHECKPOINTS_MAX_VALUE_BYTES",
  16 * 1024 * 1024,
);
export const BRAIN_CHECKPOINTS_COMPRESSION = envBool("BRAIN_CHECKPOINTS_COMPRESSION", true);

// Checkpoint write cadence for agent-loop onCheckpoint.
// CHECKPOINT_TURN_INTERVAL=1 means "every turn"; CHECKPOINT_MAX_WALL_GAP_MS
// is a wall-clock fallback that only fires at turn boundaries (it does NOT
// preempt an in-progress tool call). See checkpoint-architecture-redesign §5.4.
export const CHECKPOINT_TURN_INTERVAL = envInt("CHECKPOINT_TURN_INTERVAL", 1);
export const CHECKPOINT_MAX_WALL_GAP_MS = envInt("CHECKPOINT_MAX_WALL_GAP_MS", 60_000);

// --- Workspace sync (Plan Y v2) ---
// Sandbox rsyncs /workspace under this shared root on each checkpoint and
// SIGTERM. Empty disables shared-filesystem persistence; S3 remains available.
export const WORKSPACE_PERSIST_BASE = env("WORKSPACE_PERSIST_BASE", "");
export const WORKSPACE_SYNC_INTERVAL_MS = envInt("WORKSPACE_SYNC_INTERVAL_MS", 60_000);
export const WORKSPACE_SYNC_GRACE_MS = envInt("WORKSPACE_SYNC_GRACE_MS", 30_000);
export const WORKSPACE_SYNC_NORMAL_SLOTS = envInt("WORKSPACE_SYNC_NORMAL_SLOTS", 4);
export const WORKSPACE_SIGTERM_PRIORITY_SLOTS = envInt("WORKSPACE_SIGTERM_PRIORITY_SLOTS", 4);
export const WORKSPACE_RESTORE_TIMEOUT_MS = envInt("WORKSPACE_RESTORE_TIMEOUT_MS", 120_000);

// SIGTERM-time wait budget for an in-flight workspace_sync to drain
// before the SIGTERM catch block issues its own final writeKvCheckpoint.
// Sized so the full SIGTERM budget breakdown (15s pending-sync drain +
// 60s priority workspace sync + 3s event + 15s transcript ≈ 93s) fits
// inside the brain-deployment.yaml terminationGracePeriodSeconds (300s).
// See checkpoint-architecture-redesign.md §5.3.
export const SIGTERM_PENDING_SYNC_WAIT_MS = envInt(
  "SIGTERM_PENDING_SYNC_WAIT_MS",
  15_000,
);

// --- Hands MCP call timeouts (Plan Y v2, §5.5.2 + §6.3.2) ---
// Used by withHandsTimeout() in clients/hands.ts to put a hard ceiling on
// MCP RPCs from the brain side. Without this, a wedged Hands sandbox can
// silently hang a workspace sync / restore for the full SIGTERM grace
// window, eating the entire 99s checkpoint budget.
//   - DEFAULT  short / latency-sensitive ops (probe, read meta.json)
//   - RSYNC    workspace sync rsync commands (large fs copy)
//   - PROBE    sandbox liveness probe; must be short enough that resume
//              tolerates a few seconds of NTP drift but quick enough to
//              fall through to recreate when the sandbox is really gone.
export const HANDS_CALL_DEFAULT_TIMEOUT_MS = envInt("HANDS_CALL_DEFAULT_TIMEOUT_MS", 60 * 1000);
export const HANDS_CALL_RSYNC_TIMEOUT_MS = envInt("HANDS_CALL_RSYNC_TIMEOUT_MS", 5 * 60 * 1000);
export const PROBE_SANDBOX_TIMEOUT_MS = envInt("PROBE_SANDBOX_TIMEOUT_MS", 5 * 1000);
// Ceiling on closing a hands transport. Best-effort cleanup on a path that must
// not stall -- the run's finally block -- so it is short, and short of the
// others above because nothing downstream acts on the result.
export const HANDS_CLOSE_TIMEOUT_MS = envInt("HANDS_CLOSE_TIMEOUT_MS", 5 * 1000);

// Backstop for an UNREADABLE sandbox status only — NOT a ceiling on how long a
// healthy queued workload may wait (the name predates that change; the env key
// is kept for on-line compatibility). A readable Pending (HTTP 2xx with a phase)
// keeps being polled (a long scheduling wait at capacity is normal and must not
// fail on its own — that ceiling is SANDBOX_PENDING_TIMEOUT_SECONDS below), so
// this timer only starts mattering when SaFE stops returning a readable status:
// persistent 5xx, fetch failures, or a 2xx with an unparseable / phase-less
// body. When it fires the poll ends terminally as sandbox_status_unreadable.
// Set to 0 to disable the backstop entirely (wait forever even when unreadable)
// — NOTE this removes the only safety net, so a permanently-unreachable SaFE
// leaves the session stuck in launching with the keepalive holding the worker
// slot; prefer leaving it at the 1h default.
//
// The key + default are byte-identical to main but the MEANING changed (it used
// to be the absolute provisioning ceiling). A site that tuned it under the old
// meaning is warned at boot (index.ts validateStartupConfig →
// startup.sandbox_poll_timeout_semantics_changed) so the reinterpretation is not
// silent; the queue/Pending wait is now SANDBOX_PENDING_TIMEOUT_SECONDS below.
export const SANDBOX_POLL_TIMEOUT_MS = envInt("SANDBOX_POLL_TIMEOUT_MS", 60 * 60 * 1000);

// Maximum duration of a SINGLE continuous Pending wait (one queue episode)
// before we give up — NOT cumulative across episodes: the message is failed
// terminally with reason `sandbox_pending_timeout` (never retried) and the SaFE
// workload is reaped. Measured ONLY while phase=Pending and the clock RESETS
// whenever the workload leaves Pending, so a workload that is dispatched and
// then re-queued starts a fresh window. Once dispatched, SaFE's own workload
// timeout governs the rest of provisioning (image pull, container start) and the
// run, so a sandbox that is already scheduled and pulling a large image is never
// killed as "pending". Governs BOTH
// single-node (SafeWorkloadProvider) and multi-node clusters. Independent of the
// unreadable backstop above (which only fires when SaFE stops answering). Set to
// 0 to queue forever. Stored in ms; configured in seconds like the sibling above.
//
// NOTE (task/DAG mode only): the API-side sweeper independently fails a
// claw_tasks row as `brain_timeout` after BRAIN_TASK_TIMEOUT_SEC (code fallback
// 1h, but the Helm chart deploys 21600s = 6h) measured from started_at, with no
// liveness signal. If this ceiling can exceed that, raise BRAIN_TASK_TIMEOUT_SEC
// to match — otherwise a task's DB row goes terminal first while Brain keeps
// waiting, leaving a window where the workload still holds resources. Chat
// sessions live in claw_sessions (not claw_tasks) and are never swept.
export const SANDBOX_PENDING_TIMEOUT_MS = envInt("SANDBOX_PENDING_TIMEOUT_SECONDS", 3 * 60 * 60) * 1000;

// Hands /health readiness poll AFTER the sandbox reaches Running and the
// hands-binary bootstrap has been kicked off. Total budget ≈ TRIES * INTERVAL.
// Default raised to 40 * 3s = 120s (was a hardcoded 20 * 3s = 60s): non-Claw
// sandboxes download the ~90MB hands-binary from Brain on cold start, and under
// concurrent bring-up that download + process start can exceed 60s, which
// previously tripped a spurious `sandbox_health_failed`.
export const HANDS_HEALTH_MAX_TRIES = envInt("HANDS_HEALTH_MAX_TRIES", 40);
export const HANDS_HEALTH_INTERVAL_MS = envInt("HANDS_HEALTH_INTERVAL_MS", 3000);
// Timeout for the `start_hands` bootstrap step (download + launch + the
// env-file wait). 150s rather than 120s so a 90MB download still has ~90s
// after the 30s consumption guard and the TERM/KILL settle; 120s left the
// download only ~88s, which a concurrent cold start does not always make.
export const HANDS_BOOTSTRAP_START_TIMEOUT = env("HANDS_BOOTSTRAP_START_TIMEOUT", "150s");
/**
 * How long a source waits for its Hands to read and delete the environment
 * file before calling that Hands too old to know about it.
 *
 * On the same scale as the health budget above and for the same reason: what
 * has to fit inside it is not the read but everything before it, and a cold
 * page-in of the binary off a shared mount is the slow part. Too short is the
 * expensive direction -- it kills a healthy Hands, and since every source
 * carries the same check, a mount slow enough to trip it trips all of them and
 * the sandbox never starts. Waiting costs nothing on a working source, which
 * exits the loop on the first check that finds the file gone.
 */
export const HANDS_ENV_FILE_WAIT_SEC = envInt("HANDS_ENV_FILE_WAIT_SEC", 30, { min: 1 });

// --- Server ---
export const EXECUTOR_HOST = env("EXECUTOR_HOST", "0.0.0.0");
export const EXECUTOR_PORT = envInt("EXECUTOR_PORT", 8100);

// --- Agent Loop ---
// Tasks this pod runs at once. Two things read it: the prefetch window
// (`consume({ max_messages })`) and the execution gate that holds the delivery
// loop (tasks/execution-gate.ts). Before the gate existed only the first did,
// which made this a request-ahead hint rather than a limit.
export const MAX_CONCURRENT = envInt("MAX_CONCURRENT", 3, { min: 1 });

/**
 * How often a pod tells the server that a delivery it holds is still being
 * worked on.
 *
 * Has to be well inside the consumer's ack_wait, since each beat restarts
 * that timer and a missed one is the only way the server learns this pod is
 * gone. Ten seconds against a two-minute ack_wait leaves eleven chances to
 * miss before anything is redelivered.
 *
 * Bounded below by the same floor as the lease renewals: a beat is a publish to
 * the server for every delivery this pod holds, so a gap under a round trip is
 * the busy loop that floor exists to exclude, and the ack_wait ratio cannot
 * catch it -- anything well inside ack_wait includes a millisecond.
 */
export const DELIVERY_HEARTBEAT_MS = envInt(
  "DELIVERY_HEARTBEAT_MS",
  10_000,
  { min: MIN_RENEWAL_INTERVAL_MS },
);

/**
 * Beats a delivery must be able to miss before the server gives up on it.
 *
 * The same three as the lease heartbeat, and for the same reason: one beat
 * inside ack_wait means a single slow tick redelivers a task that is running
 * fine, and a task that keeps being redelivered runs out of its delivery budget
 * and is written off as poisoned. Checked at startup by validateStartupConfig.
 */
export const DELIVERY_HEARTBEATS_PER_ACK_WAIT = 3;

/**
 * Runs that may be resident on this pod at once, executing or parked.
 *
 * A run parked on an approval or a background command gives its execution
 * slot back but keeps its sandbox, so this is the ceiling that stands between
 * "the queue keeps moving while runs wait" and "the node runs out of memory
 * because forty runs are all waiting for someone to click approve".
 *
 * Twice MAX_CONCURRENT says a pod will hold as many waiting runs as running
 * ones. That is a guess -- the right number depends on how much of a run is
 * spent waiting, which is the thing the phase metrics are being collected to
 * find out. Setting it equal to MAX_CONCURRENT restores the old behaviour of
 * one run per slot, waiting or not. Setting it below that is refused here:
 * the gate constructor would otherwise throw at import and CrashLoop the pod.
 */
export const MAX_RESIDENT = envInt("MAX_RESIDENT", MAX_CONCURRENT * 2, { min: MAX_CONCURRENT });
export const MAX_TURNS = envInt("MAX_TURNS", 2000);
export const CALLBACK_BASE_DELAY_MS = envInt("CALLBACK_BASE_DELAY_MS", 500);
export const CALLBACK_MAX_DELAY_MS = envInt("CALLBACK_MAX_DELAY_MS", 30000);

// --- Sandbox keepalive (SaFE Workload Manager inactivity protection) ---
// Periodically `exec` a no-op inside each active Hands sandbox to refresh
// lastActivity so SaFE doesn't GC the pod mid-LLM-call. Set <=0 to disable.
export const SANDBOX_KEEPALIVE_INTERVAL_SEC = envInt("SANDBOX_KEEPALIVE_INTERVAL_SEC", 60);
// Consecutive ping failures after which a sandbox is auto-evicted (destroy the
// sandbox; the in-flight task is NOT aborted -- that would cancel DAG siblings
// sharing the session, so a task parked in an MCP call to this sandbox unblocks
// only when its transport does). Set <=0 to DISABLE eviction entirely:
// keepalive then pings forever and never aborts/destroys a sandbox on ping
// failures, so a transient control-plane outage cannot tear down a healthy
// long-running sandbox. Default 0 (disabled).
export const SANDBOX_KEEPALIVE_FAIL_LIMIT = envInt("SANDBOX_KEEPALIVE_FAIL_LIMIT", 0);
// After a retryable task exit, keep the READY sandbox alive only briefly while
// NATS redelivers the message. If no new attempt starts before this grace
// expires, sandbox-keepalive drops the hands KV entry so the control plane can
// reclaim the orphaned workload via idle/TTL GC instead of pinging forever.
export const RETRY_PENDING_KEEPALIVE_GRACE_SEC = envInt("RETRY_PENDING_KEEPALIVE_GRACE_SEC", 420);
// Periodic stale-Hands sweeper: after this many consecutive failed /health
// checks (sweeper runs ~every 5 min) a sandbox is stopped + its KV entry
// deleted. Set <=0 to DISABLE sweeper eviction entirely — health-checks still
// run and log, but a sandbox is never auto-stopped on transient health
// failures (parity with SANDBOX_KEEPALIVE_FAIL_LIMIT). Default 0 (disabled).
export const SANDBOX_SWEEPER_EVICT_AFTER_FAILURES = envInt("SANDBOX_SWEEPER_EVICT_AFTER_FAILURES", 0);
// Periodic multi-node sweeper: reclaim a session's GPU clusters once its
// sandbox has been idle (no task running) for this long. Unlike the sandbox
// itself there is no reuse value in keeping a cluster warm -- it holds whole
// GPUs -- so this is deliberately shorter than SANDBOX_IDLE_REUSE_MS.
//
// What it reaches is narrower than "any Brain that stopped": the sweep requires
// `keepalive === false` on `hands.<sid>`, and only a task reaching a terminal
// state or a session teardown that could not confirm itself ever writes that. A
// Brain killed mid-task writes neither, and nothing is left to refresh the
// entry, so the bucket TTL removes it before the idle threshold is even met.
// This is therefore the net for a per-message release that failed or never ran,
// not for a lost process; the workload's own `timeout` covers that one. Set <=0
// to disable the sweeper.
//
// Invariant worth keeping in mind when changing this: an entry has to outlive
// the wait to become eligible for it, and this threshold equals
// BRAIN_REGISTRY_TTL_MS. An entry nobody refreshes therefore expires at the
// exact moment it qualifies. The keepalive tick does refresh idle entries, which
// covers the ordinary case, but only READY ones and only while keepalive is on
// (SANDBOX_KEEPALIVE_INTERVAL_SEC > 0). Anything that comes to rely on the wait
// outside those two conditions needs this threshold moved far enough below the
// bucket TTL for a refresh or a sweep to fall in between.
export const MULTI_NODE_IDLE_RECLAIM_MS = envInt("MULTI_NODE_IDLE_RECLAIM_MS", 5 * 60 * 1000);
// How often that sweep runs. Configurable because it carries a hard constraint:
// it MUST stay below BRAIN_REGISTRY_TTL_MS.
//
// A handle parked by a session delete is the only route left to that session's GPU
// clusters, and how long it survives is not uniform. A parked READY handle is
// re-put by every keepalive tick -- collectTargets refreshes idle entries rather
// than pinging them -- so it lasts until SANDBOX_IDLE_REUSE_MS. A parked PENDING
// handle gets no refresh, since that path takes only READY entries, and neither
// does anything when keepalive is switched off. Those two live exactly one bucket
// TTL, so the sweep has to come round inside that or the entry expires unseen and
// the whole fallback is gone, silently, leaving the clusters to the workload's own
// timeout. The shortest lifetime is what this has to fit under, not the longest.
// Left at the same value as the TTL the margin would be zero; the default is
// deliberately well under it. validateStartupConfig checks the inequality at boot,
// because a deployment that tunes the TTL down has no other way to find out.
export const MULTI_NODE_SWEEPER_INTERVAL_MS = envInt(
  "MULTI_NODE_SWEEPER_INTERVAL_MS",
  2 * 60 * 1000,
);

// --- Sub-agent budgets (ported from Claw V1) ---
// SUB_AGENT_MAX_TURNS: upper bound on turns inside a sub-agent. 0 disables
// the `task` tool entirely (sub-agents unavailable).
export const SUB_AGENT_MAX_TURNS = envInt("SUB_AGENT_MAX_TURNS", 0);
export const SUB_AGENT_MAX_CONCURRENT = envInt("SUB_AGENT_MAX_CONCURRENT", 2);
export const SUB_AGENT_MAX_DEPTH = envInt("SUB_AGENT_MAX_DEPTH", 1);
// Block sub-agent dispatches whose prompt is dominated by skill-file reads.
// The dispatch is rejected with an error message instructing the agent to
// use the direct `read` tool. Mitigates a recurring pattern where Opus
// wraps multi-file skill reads in explore sub-agents, paying 4-7 LLM turns
// per dispatch + final_text truncation that triggers re-dispatches
// (validated regression: session 37dbaecd 14 min vs ~2 min via direct read).
// Disable by setting BRAIN_BLOCK_SKILL_SUBAGENTS=false if it bites.
export const BRAIN_BLOCK_SKILL_SUBAGENTS = envBool("BRAIN_BLOCK_SKILL_SUBAGENTS", true);

// --- In-flight sandbox rebuild (agent-loop recovery) ---
// When the Hands MCP client surfaces N consecutive network errors within a
// single task, the loop destroys the dead workload and creates a fresh one,
// then resumes the LLM interaction. Prevents the LLM from burning turns on
// inevitable tool failures after a sandbox dies mid-task.
export const SANDBOX_REBUILD_THRESHOLD = envInt("SANDBOX_REBUILD_THRESHOLD", 3);
export const SANDBOX_REBUILD_MAX_PER_TASK = envInt("SANDBOX_REBUILD_MAX_PER_TASK", 3);

/**
 * Recoveries per task that did not replace the sandbox, before the loop stops
 * trying.
 *
 * Separate budget from SANDBOX_REBUILD_MAX_PER_TASK because the two bound
 * different risks. A rebuild is expensive and destructive, so three per task is
 * generous; renewing a transport is neither, but repeating it forever against a
 * sandbox that never comes back is how a run burns its whole turn budget while
 * reporting progress. The counter resets whenever a sandbox tool call
 * subsequently succeeds, so a long run that blips occasionally is unaffected --
 * only repetition without progress reaches the cap.
 */
export const SANDBOX_RECOVERY_MAX_PER_TASK = envInt("SANDBOX_RECOVERY_MAX_PER_TASK", 3);

/**
 * Whether a container that is alive with a dead Hands may have Hands started
 * again in place, instead of being destroyed and rebuilt.
 *
 * On by default because the alternative loses the contents of a live container:
 * a Hyperloom or GPU job holding that pod dies with it, and the MCP server
 * being gone says nothing about that job. Restarting in place is also far
 * cheaper -- the binary is already in the container from the first bootstrap.
 * Turn it off to get the old behaviour of rebuilding whenever MCP cannot be
 * reached -- but only where a rebuild is on the table at all, which is a task
 * attaching to the session. A task already running against a container the
 * probe confirms is alive never replaces it, switch off or on: that trade
 * destroys work that is still running in order to repair a tool server, so
 * the run reports the failure and ends instead.
 */
export const SANDBOX_HANDS_RESTART_ENABLED = envBool("SANDBOX_HANDS_RESTART_ENABLED", true);

/**
 * Health poll after restarting Hands in place: 10 * 2s = 20s.
 *
 * Much shorter than the 120s the create path allows, because the two wait for
 * different things. A cold sandbox may be downloading a 90MB binary; a restart
 * runs one that is already in the container, so anything beyond a few seconds
 * means it is not coming up, and this poll sits on the tool-batch path where a
 * two-minute stall would cost more than the rebuild it is trying to avoid.
 */
// At least one: zero tries SIGKILLs a live Hands and then never asks whether
// the replacement came up, which reports failure for every restart that works.
export const SANDBOX_HANDS_RESTART_MAX_TRIES = envInt(
  "SANDBOX_HANDS_RESTART_MAX_TRIES", 10, { min: 1 },
);
export const SANDBOX_HANDS_RESTART_INTERVAL_MS = envInt(
  "SANDBOX_HANDS_RESTART_INTERVAL_MS", 2000, { min: 1 },
);
/**
 * Wall clock for kill + bootstrap only. Health polling is separate
 * (SANDBOX_HANDS_RESTART_MAX_TRIES * INTERVAL).
 *
 * Longer than the 8s probe: this path has to start a process, not just run
 * `true`. Shorter than the create-path 150s bootstrap: the binary is already
 * in the container, and this sits on the tool-batch path.
 */
export const SANDBOX_HANDS_RESTART_EXEC_DEADLINE_MS = envInt(
  "SANDBOX_HANDS_RESTART_EXEC_DEADLINE_MS",
  45_000,
  // Below a second there is no room for the kill to land before the deadline
  // fires, so every restart is abandoned and none can succeed.
  { min: 1_000 },
);

// --- Conversation compaction trigger ---
// Auto-compaction collapses old turns into a summary when a single turn's
// cumulative input_tokens crosses this threshold. AMD's LiteLLM gateway
// publishes claude-opus-4-7 with max_input_tokens=1_000_000 (verified live:
// a single 560K-input request completed end-to-end without truncation).
//
// Default of 850K leaves ~150K headroom for the *fallback* path: if the
// summarizer call itself fails, the loop continues with the un-compacted
// history, so the next turn must still fit under 1M after appending the
// current turn's assistant + tool_results (~30K) and the next user input.
// The compaction summarizer call is independently safe because it
// truncates middleText to 600K chars (~170K tokens) before sending.
//
// Set to 120000 (legacy 200K-window default) via env if the deployment
// later switches to a model whose effective context is back at 200K.
export const COMPACTION_TRIGGER_INPUT_TOKENS = envInt("COMPACTION_TRIGGER_INPUT_TOKENS", 850_000);

// --- Prompt cache ---
/**
 * Lifetime of the cache entries Brain writes, "5m" or "1h".
 *
 * "1h" by default because of what this deployment's agents actually do between
 * requests. The babysitter tasks that motivated this run `sleep 300` inside a
 * single tool call, so the gap between the request that emits the sleep and
 * the one that reads its result is over five minutes every cycle -- the one
 * request in three that a 5-minute entry cannot survive, and the most
 * expensive one, since it is the full conversation that gets re-written rather
 * than read. Measured against the live gateway: a 1h marker writes a real
 * `ephemeral_1h` entry, needs no beta header, is not silently downgraded to
 * 5m, and is still readable seven minutes later. The 2x write premium buys
 * roughly 9x against today's cost where 5m buys about 2x.
 *
 * "5m" is the escape hatch if a gateway ever starts refusing the ttl field.
 */
export type PromptCacheTtl = "5m" | "1h";
function resolvePromptCacheTtl(): PromptCacheTtl {
  const configured = env("LLM_CACHE_TTL");
  if (configured === "5m" || configured === "1h") return configured;
  if (configured) {
    settingProblems.push(`LLM_CACHE_TTL=${configured} is not "5m" or "1h"; using 1h`);
  }
  return "1h";
}
export const LLM_CACHE_TTL: PromptCacheTtl = resolvePromptCacheTtl();

/**
 * Turns off client-side cache breakpoints entirely.
 *
 * The provider already disables itself for the rest of a session when the
 * gateway rejects a marker, so this is not the first line of defence -- it is
 * the one an operator can reach without a code change when the failure is
 * something the latch does not recognise. Rolling restart, not a live flip:
 * every constant in this file is read once at import.
 */
export const PROMPT_CACHE_ENABLED = envBool("PROMPT_CACHE_ENABLED", true);

/**
 * What is behind an OpenAI-shaped endpoint, stated by the operator.
 *
 * Two dialects share one slot on that wire. A gateway forwarding to Anthropic
 * models reads `cache_control` inside a content part; genuine OpenAI reads
 * `prompt_cache_breakpoint` and caches automatically besides. Sending the
 * wrong one is not symmetric with sending none, so this is not guessed.
 *
 * And it cannot be guessed from the URL, which is the whole reason it is a
 * setting: OPENAI_BASE_URL falls back to ANTHROPIC_BASE_URL above, so on this
 * very deployment both backends can present the same string.
 *
 * Default "native" because that is the safe half of a wrong guess. Wrong
 * toward native costs money on a gateway that would have honoured markers --
 * visible immediately in claw_brain_llm_cache_turns_total{state="miss"}.
 * Wrong toward anthropic puts an unrecognised key in the body of every request
 * to a real OpenAI endpoint, and an endpoint that rejects it fails the run.
 * Losing money loudly beats failing quietly.
 *
 * Read only when LLM_API_STYLE is "openai"; the Anthropic path declares its
 * backend by being that path. Refused values land in settingProblems rather
 * than throwing, unlike LLM_API_STYLE: a wrong wire protocol fails every
 * request, so dying is honest there, but a mistyped cost knob must not be able
 * to stop a pod from booting.
 */
export type LlmCacheStyle = "off" | "anthropic" | "native";
function resolveLlmCacheStyle(): LlmCacheStyle {
  const configured = env("LLM_CACHE_STYLE");
  if (configured === "off" || configured === "anthropic" || configured === "native") return configured;
  if (configured) {
    settingProblems.push(`LLM_CACHE_STYLE=${configured} is not "off", "anthropic" or "native"; using off`);
  }
  // Off by default. Markers on this wire are a claim about an endpoint that
  // cannot be interrogated, and a wrong claim is REFUSED rather than merely
  // uncached -- so a default that sends something spends a failed request and
  // a probe on the first markable turn of every session, on every deployment
  // that never chose a dialect. A log line that fires once per session cannot
  // report a regression.
  return "off";
}
export const LLM_CACHE_STYLE: LlmCacheStyle = resolveLlmCacheStyle();

/**
 * True when the deployment has said the OpenAI-shaped endpoint reads Anthropic
 * cache markers, i.e. when Brain should place `cache_control` on that wire.
 */
export const OPENAI_CACHE_MARKERS =
  LLM_API_STYLE === "openai" && PROMPT_CACHE_ENABLED && LLM_CACHE_STYLE !== "off";

/**
 * The OPENAI_BASE_URL fallback fired: the deployment selected the OpenAI wire
 * protocol and never set a URL for it, so chat/completions is pointed at
 * whatever ANTHROPIC_BASE_URL names -- in this fleet, a gateway serving
 * Anthropic models. That is the configuration in which leaving
 * LLM_CACHE_STYLE at "native" silently pays full price on every request, so it
 * is worth saying out loud at boot rather than discovering on a bill.
 */
export function openAiBaseUrlFellBack(): boolean {
  return LLM_API_STYLE === "openai" && !env("OPENAI_BASE_URL") && Boolean(ANTHROPIC_BASE_URL);
}


// --- LLM streaming timeouts (SSE-style response body) ---
// Aligned to LiteLLM gateway's read=600s to avoid client-side aborts that
// the upstream proxy would still consider in-flight. Long prefill on big
// prompts (>500K tokens) can legitimately take 90s+ before the first
// SSE event arrives — the previous 90s idle cap killed those streams
// prematurely and surfaced as STREAM_TRUNCATED stop_reason=null.
export const STREAM_FIRST_BYTE_TIMEOUT_MS = envInt("STREAM_FIRST_BYTE_TIMEOUT_MS", 600_000);
// Max idle gap between two consecutive stream chunks after the first byte.
// Reset on every chunk received.
export const STREAM_IDLE_TIMEOUT_MS = envInt("STREAM_IDLE_TIMEOUT_MS", 600_000);

// --- fetch retry timeouts (three-layer guard used by infra/retry.ts) ---
// Headers:  connect + send + first byte of response headers.
// BodyIdle: after headers, max silence between streamed body chunks.
// Total:    absolute wall-clock upper bound for the whole request.
// All three are aligned to LiteLLM gateway's 600s read/write/pool budget.
export const FETCH_HEADERS_TIMEOUT_MS = envInt("FETCH_HEADERS_TIMEOUT_MS", 600_000);
export const FETCH_BODY_IDLE_TIMEOUT_MS = envInt("FETCH_BODY_IDLE_TIMEOUT_MS", 600_000);
export const FETCH_TOTAL_TIMEOUT_MS = envInt("FETCH_TOTAL_TIMEOUT_MS", 600_000);

// --- Web Search ---
export type WebSearchProviderType = "anthropic" | "tavily" | "brave" | "serper" | "disabled";
export const WEB_SEARCH_PROVIDER = env("WEB_SEARCH_PROVIDER", "disabled") as WebSearchProviderType;
export const WEB_SEARCH_FALLBACK = env("WEB_SEARCH_FALLBACK", "");
export const WEB_SEARCH_MAX_USES = envInt("WEB_SEARCH_MAX_USES", 8);
export const TAVILY_API_KEY = env("TAVILY_API_KEY");
export const BRAVE_API_KEY = env("BRAVE_API_KEY");
export const SERPER_API_KEY = env("SERPER_API_KEY");
export const WEB_SEARCH_MODEL = env("WEB_SEARCH_MODEL", "");
export const WEB_SEARCH_FORCE_TOOL = envBool("WEB_SEARCH_FORCE_TOOL", true);
export const WEB_SEARCH_DOMAIN_DENYLIST = env("WEB_SEARCH_DOMAIN_DENYLIST", "");

// --- Web Fetch ---
export const WEB_FETCH_ENABLED = envBool("WEB_FETCH_ENABLED", false);
export const WEB_FETCH_MAX_BYTES = envInt("WEB_FETCH_MAX_BYTES", 10 * 1024 * 1024);
export const WEB_FETCH_MAX_OUTPUT_CHARS = envInt("WEB_FETCH_MAX_OUTPUT_CHARS", 50_000);
export const WEB_FETCH_DOMAIN_DENYLIST = env("WEB_FETCH_DOMAIN_DENYLIST", "");
export const WEB_FETCH_TIMEOUT_MS = envInt("WEB_FETCH_TIMEOUT_MS", 60_000);
export const WEB_FETCH_SUMMARIZE = envBool("WEB_FETCH_SUMMARIZE", true);
export const WEB_FETCH_SUMMARIZE_MODEL = env("WEB_FETCH_SUMMARIZE_MODEL", "claude-3-5-haiku-latest");
export const WEB_FETCH_CACHE_TTL_MS = envInt("WEB_FETCH_CACHE_TTL_MS", 15 * 60 * 1000);
export const WEB_FETCH_CACHE_MAX_BYTES = envInt("WEB_FETCH_CACHE_MAX_BYTES", 50 * 1024 * 1024);

// --- Workspace per-message immutable archive ---
// /workspace itself is ALWAYS synced to S3 at the end of each completed task
// (top-level layout under `users/<uid>/sessions/<sid>/`) — it's the round-trip
// counterpart of syncWorkspaceFromS3 used during sandbox rehydrate, so it must
// run unconditionally for artifact persistence and cross-sandbox continuity.
//
// This flag only gates the additional per-message immutable archive: after the
// sync, server-side CopyObject the top-level keys into `claw-<messageId>/`
// for historical traceability. Zero body transfer (S3 metadata op) but it
// duplicates storage — disabled by default since most deployments don't need
// historical snapshots. The SIGTERM checkpoint path is independent of this
// flag (it serves recovery, not user-facing artifacts).
export const BRAIN_WORKSPACE_SNAPSHOT_ENABLED = envBool("BRAIN_WORKSPACE_SNAPSHOT_ENABLED", false);

// --- Todo Write ---
export const TODO_WRITE_ENABLED = envBool("TODO_WRITE_ENABLED", true);

// --- Plan Mode ---
export const EXIT_PLAN_MODE_ENABLED = envBool("EXIT_PLAN_MODE_ENABLED", true);

// --- Ask User Question ---
export const ASK_USER_QUESTION_ENABLED = envBool("ASK_USER_QUESTION_ENABLED", false);
export const ASK_USER_QUESTION_TIMEOUT_MS = envInt("ASK_USER_QUESTION_TIMEOUT_MS", 600_000);

// --- Background Shell ---
export const BG_SHELL_ENABLED = envBool("BG_SHELL_ENABLED", false);

/**
 * The foreground command ceiling, for describing the bash tool to the model.
 *
 * Enforcement is in Hands, which is where the process actually runs, so the
 * schema and the sandbox have to state one number. That number is this setting
 * held under the MCP hard cap by `toolTimeoutCeilingSec`, and the held one is
 * what travels to Hands as `BASH_MAX_TIMEOUT_SEC`: forwarding the setting
 * itself left the schema promising 3540s against a sandbox honouring 36000.
 * It travels with the rest of the sandbox env for the same reason
 * `BG_SHELL_ENABLED` does: two sides disagreeing about a limit is worse than
 * either value on its own.
 *
 * 120s is the right ceiling only where long work has another route. That route
 * is `run_in_background` plus `wait`, which BG_SHELL_ENABLED turns off, and with
 * it off a 120s ceiling means no command over two minutes can run at all -- most
 * builds, most test suites, every training run. So the default follows the
 * escape hatch rather than standing alone: 120s where the hatch exists, and the
 * ten hours this replaces where it does not. An operator who sets the variable
 * gets exactly that number either way.
 *
 * The 120s is not an arbitrary two minutes. It is the foreground ceiling in the
 * handover constraint the Hands-side comment derives -- ceiling <= checkpoint
 * and sync budget < graceful shutdown, 300s in the chart -- which is what makes
 * "every foreground command the previous owner started has ended" true when a
 * run moves to another replica. With the escape hatch off, the ten-hour ceiling
 * does not satisfy it: the window in which two replicas can both be driving one
 * workspace is as wide as the ceiling. That is the trade the hatch buys, and it
 * is why the chart documents the pairing beside the feature flag.
 */
export const BASH_FOREGROUND_MAX_SEC = envInt(
  "BASH_MAX_TIMEOUT_SEC",
  BG_SHELL_ENABLED ? 120 : 36_000,
  // A ceiling of zero or less is not "no limit". At zero the RPC deadline this
  // now builds collapses to the transport slack alone, one minute for every
  // command whatever it asked for; below minus the slack it goes negative,
  // which the MCP client treats as already expired. Refused so a typo shows up
  // at startup instead of as every bash call failing on its first tick.
  { min: 1 },
);

/**
 * The default the model is told about, mirroring Hands' BASH_DEFAULT_TIMEOUT_SEC.
 *
 * Separate from the ceiling because the two only coincide at 120s: once the
 * ceiling is the ten-hour one, a schema that reports it as the default invites
 * every command to be planned as if it had ten hours.
 */
export const BASH_FOREGROUND_DEFAULT_SEC = envInt("BASH_DEFAULT_TIMEOUT_SEC", 120);

/**
 * The ceiling on one `wait` call, mirroring Hands' WAIT_MAX_SEC.
 *
 * Far longer than the foreground ceiling, and deliberately so: a wait is not
 * doing anything, so abandoning one costs nothing and leaves nothing
 * half-written, which is the whole argument the foreground ceiling rests on.
 *
 * Brain needs the number because it builds the RPC deadline for the call, and
 * Hands clamps a larger `timeout_sec` to this without saying so. A deadline
 * built from the unclamped argument would leave the run waiting long after the
 * wait it is waiting on has returned. It travels to Hands with the sandbox env
 * for the same reason `BASH_MAX_TIMEOUT_SEC` does -- and, like it, only reaches
 * a sandbox created after the change: a reused one is still running the Hands
 * it was started with, so for a while the two sides do disagree, with Brain's
 * copy deciding only the deadline and the older Hands deciding the clamp.
 *
 * Refused below 1 for the same reason the foreground ceiling is: a wait whose
 * deadline is the transport slack alone is a wait that cannot wait.
 */
export const WAIT_MAX_SEC = envInt("WAIT_MAX_SEC", 1_800, { min: 1 });

/**
 * The default a `wait` that names no timeout gets, mirroring Hands'
 * WAIT_DEFAULT_SEC.
 *
 * Here for the same reason `BASH_DEFAULT_TIMEOUT_SEC` is: the schema states the
 * default as well as the cap, and stating one Hands does not use is how a model
 * comes to plan around a wait length nothing enforces. It travels with the rest
 * of the sandbox env so the number the schema names is the number that applies.
 */
export const WAIT_DEFAULT_SEC = envInt("WAIT_DEFAULT_SEC", 300, { min: 1 });

// --- HITL ---
export const HITL_ENABLED = envBool("HITL_ENABLED", false);
export const HITL_AUTO_ALLOW = env("HITL_AUTO_ALLOW", "read,glob,grep,ls,todo_write,web_search,save_memory");
export const HITL_DECISION_TIMEOUT_MS = envInt("HITL_DECISION_TIMEOUT_MS", 300_000);
export const HITL_DECISION_DEFAULT = env("HITL_DECISION_DEFAULT", "allow");

// --- Rules ---
export const RULES_ENABLED = envBool("RULES_ENABLED", false);
export const RULES_DIR = env("RULES_DIR", "/app/rules");
export const SAFETY_PREAMBLE_ENABLED = envBool("SAFETY_PREAMBLE_ENABLED", true);
