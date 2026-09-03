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
  resolveLeaseReapGraceSec,
  resolveTaskDeliveryBudget,
  RUN_LEASE_HEARTBEATS_PER_TTL,
  type RunLeaseTiming,
} from "@claw/protocol";
import { readIntSetting, type IntSettingBounds } from "@claw/utils";

/**
 * Read a setting, treating blank the same as unset.
 *
 * `||` rather than `??`: `start-all.sh` does `set -a; source .env`, so every
 * key `.env.example` deliberately leaves empty is *exported as ""* rather than
 * absent, and `??` substitutes the fallback only for `undefined`. Blank would
 * otherwise win over the documented default -- an empty `S3_BUCKET` is not a
 * bucket, and an empty `MEMORY_LLM_MODEL` never reaches `DEFAULT_MODEL`.
 *
 * It matches the siblings below, which already read blank as absent: `envBool`
 * returns its fallback for one, and `envInt` defers to `readIntSetting`, which
 * documents blank as "an absent setting". The trade is that no setting here can
 * be configured *to* the empty string.
 */
function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

/**
 * Settings that were set and then ignored, for startup to report.
 *
 * A value this file refuses is more alarming than one nobody set: somebody
 * meant it, and the process is running on a default instead. There is no logger
 * at the time constants are evaluated, so the reasons are collected here and
 * read by `validateStartupConfig()`.
 */
const settingProblems: string[] = [];

/** Why any configured value was refused, in the operator's terms. */
export function envSettingProblems(): readonly string[] {
  return settingProblems;
}

/**
 * Add a refusal this file could not have made itself.
 *
 * `envInt` only knows the bounds it was handed. A setting whose floor depends
 * on another setting is decided by the module that owns both, and it has the
 * same problem: constants are evaluated before there is a logger, and a value
 * quietly replaced at that point is one nobody hears about until they wonder
 * why nothing happened.
 */
export function reportSettingProblem(problem: string): void {
  settingProblems.push(problem);
}

/**
 * Exported because modules outside this file read env vars of their own, and
 * `Number(process.env.X ?? fallback)` is not the same function: an env var set
 * to the empty string is 0 rather than the fallback, and one set to a typo is
 * NaN, which reaches Postgres as `$1::int` and throws on every tick. Whether a
 * value is *sane* is a separate question, asked where the value is used.
 *
 * The bounds default to what Postgres will take, because most of these end up
 * as `$n::int` in a sweeper query. Callers that need a narrower range say so.
 */
export function envInt(key: string, fallback: number, bounds?: IntSettingBounds): number {
  const setting = readIntSetting(process.env[key], bounds);
  if (setting === null) return fallback;
  if ("problem" in setting) {
    settingProblems.push(`${key}=${env(key)} ${setting.problem}; using ${fallback}`);
    return fallback;
  }
  return setting.value;
}

/** Exported for the same reason as {@link envInt}: so nobody writes a fourth one. */
export function envBool(key: string, fallback: boolean): boolean {
  const v = env(key).toLowerCase();
  if (!v) return fallback;
  return ["true", "1", "yes"].includes(v);
}

export const API_PORT = envInt("API_PORT", 8000);
export const APP_ENV = env("APP_ENV", "production");

/**
 * The `origin` option for @fastify/cors, from a raw CORS_ORIGINS value.
 *
 * Exported so the decision is testable at the line that makes it. Inlined in
 * the server's bootstrap it could only be re-implemented by a test, which
 * proves the reimplementation and not the server.
 *
 * `false` -- no cross-origin access -- rather than `true` when the list is
 * empty. `true` makes @fastify/cors echo the request's Origin and pair it with
 * Access-Control-Allow-Credentials, which is what lets any site read an
 * authenticated response using the visitor's session cookie. Reaching that by
 * leaving a variable blank is the wrong direction to fail in, and blank is
 * exactly what `.env.example` ships.
 */
export function resolveCorsOrigin(raw: string | undefined): string[] | false {
  const origins = (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  return origins.length > 0 ? origins : false;
}
export const SAFE_API_URL = env("SAFE_API_URL");

// --- Deploy mode ---
// "safe": existing SaFE deployment (SaFE auth). "kubernetes": standalone BYOK (no SaFE auth).
export type DeployMode = "safe" | "kubernetes";
export const CLAW_DEPLOY_MODE: DeployMode =
  env("CLAW_DEPLOY_MODE", "safe") === "kubernetes" ? "kubernetes" : "safe";
export function isKubernetesMode(): boolean {
  return CLAW_DEPLOY_MODE === "kubernetes";
}

// --- LLM key source ---
// "virtualKey" preserves the existing behavior. "platformKey" is proxy mode:
// Brain receives platform_key as llm_api_key so LLM calls authenticate via the
// same per-user SaFE/proxy key used by the platform.
export type LlmKeySource = "virtualKey" | "platformKey";
export const LLM_KEY_SOURCE: LlmKeySource =
  env("LLM_KEY_SOURCE", "virtualKey") === "platformKey" ? "platformKey" : "virtualKey";
export function usePlatformKeyForLlm(): boolean {
  return LLM_KEY_SOURCE === "platformKey";
}

// Default prompt-builder images are deployment-specific, not source-hardcoded.
export const HYPERLOOM_DEFAULT_IMAGE = env("HYPERLOOM_DEFAULT_IMAGE");
export const GEAK_DEFAULT_IMAGE = env("GEAK_DEFAULT_IMAGE");
export const LITELLM_API_BASE = env("LITELLM_API_BASE");
export const SAFE_DEFAULT_WORKSPACE = env("SAFE_DEFAULT_WORKSPACE", "default");

/**
 * Assemble DATABASE_URL. Precedence:
 *   1. Explicit DATABASE_URL env (wins outright).
 *   2. PGO-style POSTGRES_{HOST,PORT,USER,PASSWORD,DB,SSLMODE} (what the
 *      deploy manifests project from the primus-claw-pguser-* secret).
 *   3. Local-dev fallback.
 */
function buildDatabaseUrl(): string {
  const explicit = env("DATABASE_URL");
  if (explicit) return explicit;

  const host = env("POSTGRES_HOST");
  if (!host) return "postgres://postgres:dev@localhost:5432/primus-claw";

  const port = env("POSTGRES_PORT", "5432");
  const user = env("POSTGRES_USER", "postgres");
  const password = encodeURIComponent(env("POSTGRES_PASSWORD"));
  const db = env("POSTGRES_DB", "primus-claw");
  const sslmode = env("POSTGRES_SSLMODE", "require");
  return `postgres://${user}:${password}@${host}:${port}/${db}?sslmode=${sslmode}`;
}
export const DATABASE_URL = buildDatabaseUrl();
export const NATS_URL = env("NATS_URL", "nats://localhost:4222");
// NATS account-based isolation: each dev/env connects with its own NATS
// account credentials. Stream/subject names are stable (see infra/nats.ts), the
// account boundary itself provides multi-tenant isolation.
export const NATS_USER = env("NATS_USER");
export const NATS_PASSWORD = env("NATS_PASSWORD");
export const AUTH_INTERNAL_TOKEN = env("AUTH_INTERNAL_TOKEN");
export const HARNESS_USER_WHITELIST = new Set(
  env("HARNESS_USER_WHITELIST").split(",").map(s => s.trim()).filter(Boolean),
);

// --- Shared task consumer (brain-workers durable) ---
// The API provisions the durable, so these are the fleet's values rather than
// this process's preference; brain reads the same two env vars only to verify
// what it finds. Both deployments take primus-claw-secrets wholesale, so one
// setting reaches both -- see @claw/protocol/task-consumer for why the durable
// has exactly one writer.
const taskDeliveryBudget = resolveTaskDeliveryBudget(
  envInt("TASK_MAX_DELIVER", DEFAULT_TASK_MAX_DELIVER),
);
export const TASK_MAX_DELIVER = taskDeliveryBudget.maxDeliver;
export const TASK_POISON_DELIVERY_COUNT = taskDeliveryBudget.poisonDeliveryCount;
export const TASK_MAX_ACK_PENDING = envInt(
  "TASK_MAX_ACK_PENDING",
  DEFAULT_TASK_MAX_ACK_PENDING,
);

// --- Declaring a run dead ---
// Four numbers decide it, they live in two processes, and only their ordering
// is right or wrong -- see @claw/protocol/run-lease for the relation and
// assertRunLeaseTiming below for where it is enforced. Read from the same env
// vars brain reads, because both deployments take primus-claw-secrets wholesale:
// one setting reaches both sides, which is what keeps them agreeing.
export const BRAIN_REGISTRY_TTL_MS = envInt(
  "BRAIN_REGISTRY_TTL_MS",
  DEFAULT_BRAIN_REGISTRY_TTL_MS,
);

// Replica counts for the KV buckets this process creates, read from the same
// variables brain reads for the two it shares -- same reasoning as the TTL
// above, and the same failure when they disagree.
//
// These were hardcoded to 3, which is right for the clustered NATS the Helm
// chart installs and impossible for the single `nats-server -js` the local
// quick start implies: JetStream answers a replicas>1 request in non-clustered
// mode with "replicas > 1 not supported in non-clustered mode" (err 10074), so
// the API died provisioning its first bucket and no README said why. The floor
// is 1 rather than 0 because a bucket with no replicas is not a bucket.
//
// NATS_REPLICAS is the deployment-wide default the rest fall back to, so a
// single-node dev server needs one variable rather than one per object. Each
// object keeps its own override: they were the existing names, and a cluster
// that wants the event stream wider than the registry can still say so.
export const NATS_REPLICAS = envInt("NATS_REPLICAS", 3, { min: 1 });
export const BRAIN_REGISTRY_REPLICAS = envInt("BRAIN_REGISTRY_REPLICAS", NATS_REPLICAS, { min: 1 });
export const BRAIN_CHECKPOINTS_REPLICAS = envInt("BRAIN_CHECKPOINTS_REPLICAS", NATS_REPLICAS, { min: 1 });
export const SYSTEM_ENV_REPLICAS = envInt("SYSTEM_ENV_REPLICAS", NATS_REPLICAS, { min: 1 });
// The two streams, which had no replica setting at all and so were created at
// the JetStream default of 1. A single-replica stream lives on exactly one
// server: when that server's pod went away on 2026-09-01 nothing was hosting
// `tasks.>`, every `js.publish` came back NO_RESPONDERS -- which the client
// reports as the bare code "503" -- and the API turned that into a 503 on
// POST /sessions for four and a half hours. Quorum was never the problem;
// a stream with one replica does not have a quorum to lose.
export const TASK_STREAM_REPLICAS = envInt("TASK_STREAM_REPLICAS", NATS_REPLICAS, { min: 1 });
export const EVENT_STREAM_REPLICAS = envInt("EVENT_STREAM_REPLICAS", NATS_REPLICAS, { min: 1 });
// Bounded the way brain bounds the same two variables, because unbounded on one
// side of a shared setting is what lets one variable mean two things:
// `RUN_LEASE_TTL_MS=0` is refused there and taken literally here, and the zero
// then flows into resolveLeaseReapGraceSec, which decides how long after a lease
// lapses a run may be declared dead. A renewal is a round trip, so the floor is
// a second; a lease has to cover the renewals it promises, so its floor is that
// times RUN_LEASE_HEARTBEATS_PER_TTL.
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
// A second is already far below anything this loop is meant for; the bound is
// there because the failure is a busy loop against the database rather than a
// sweeper that runs slightly too often.
export const TASK_SWEEPER_TICK_MS = envInt("TASK_SWEEPER_TICK_MS", 60_000, { min: 1_000 });
/**
 * How long past its expiry a lease may sit before the run is declared gone.
 *
 * Derived rather than chosen, and derived from the thing it must not preempt:
 * the redelivery that would have resumed the run. That redelivery has to wait
 * out the dead worker's `lock.<key>`, so the wait is a function of the registry
 * bucket's TTL and the nak backoff, not of ack_wait -- which is what the
 * hand-picked 120 was measured against, and why it closed runs that were still
 * resumable. Overridable, but the override is checked at startup rather than
 * trusted.
 */
export const LEASE_LOST_GRACE_SEC = envInt(
  "LEASE_LOST_GRACE_SEC",
  resolveLeaseReapGraceSec({
    leaseTtlMs: RUN_LEASE_TTL_MS,
    heartbeatMs: RUN_LEASE_HEARTBEAT_MS,
    lockTtlMs: BRAIN_REGISTRY_TTL_MS,
    sweeperTickMs: TASK_SWEEPER_TICK_MS,
    maxDeliver: TASK_MAX_DELIVER,
  }),
  // Reaches the reap query as `$1::int`, where anything wider is not a long
  // grace but a thrown query -- and because that reaper runs third, every
  // reaper behind it would be skipped on every tick.
  { min: 1 },
);

/** The timings above as the one thing they actually are: a single ordering. */
export function runLeaseTiming(): RunLeaseTiming {
  return {
    leaseTtlMs: RUN_LEASE_TTL_MS,
    heartbeatMs: RUN_LEASE_HEARTBEAT_MS,
    graceSec: LEASE_LOST_GRACE_SEC,
    lockTtlMs: BRAIN_REGISTRY_TTL_MS,
    sweeperTickMs: TASK_SWEEPER_TICK_MS,
    maxDeliver: TASK_MAX_DELIVER,
  };
}

export const S3_ACCESS_KEY = env("S3_ACCESS_KEY");
export const S3_SECRET_KEY = env("S3_SECRET_KEY");
export const S3_BUCKET = env("S3_BUCKET", "claw");
export const S3_REGION = env("S3_REGION", "us");
export const S3_ENDPOINT = env("S3_ENDPOINT");
export const S3_PLUGINS_BUCKET = env("S3_PLUGINS_BUCKET", "plugins");
// S3_API_ENDPOINT: override that forces S3 SDK traffic at a specific S3 API
// endpoint. Falls back to S3_ENDPOINT when unset so existing deployments
// keep their current behavior. Use this when S3_ENDPOINT was (mis)configured
// at a non-API URL such as the MinIO Console port — callers that need real
// S3 semantics (e.g. plugins) can opt into the correct API host/port
// without mutating S3_ENDPOINT and affecting unrelated consumers.
export const S3_API_ENDPOINT = env("S3_API_ENDPOINT") || S3_ENDPOINT;

// --- Upload TTL sweeper (S3 `.uploads/` per-session cleanup) ---
// TTL for per-session upload artifacts in days. 0 disables the sweeper.
export const UPLOAD_TTL_DAYS = envInt("UPLOAD_TTL_DAYS", 7);
// Sweep cadence in minutes.
export const UPLOAD_SWEEP_INTERVAL_MIN = envInt("UPLOAD_SWEEP_INTERVAL_MIN", 60);

// --- Memory / Skill LLM ---
export const MEMORY_LLM_MODEL = env("MEMORY_LLM_MODEL", env("DEFAULT_MODEL", "claude-opus-4-6"));
export const MEMORY_LLM_API_KEY = env("MEMORY_LLM_API_KEY", env("ANTHROPIC_AUTH_TOKEN", env("ANTHROPIC_API_KEY")));
export const MEMORY_LLM_BASE_URL = env("MEMORY_LLM_BASE_URL", env("ANTHROPIC_BASE_URL"));
export type LlmApiStyle = "anthropic" | "openai";
// Keep this value raw: auth/byok.ts uses the configured source to determine
// the verification protocol, so falling back to ANTHROPIC_BASE_URL here would
// incorrectly turn a native Anthropic endpoint into an OpenAI/Bearer target.
export const OPENAI_BASE_URL = env("OPENAI_BASE_URL");
export const BYOK_VERIFY_MODELS_URL = env("BYOK_VERIFY_MODELS_URL");
export const BYOK_VERIFY_API_STYLE = env("BYOK_VERIFY_API_STYLE");
export const ANTHROPIC_BASE_URL = env("ANTHROPIC_BASE_URL");

// --- Skill selection ---
export const MAX_SELECTED_SKILLS = envInt("MAX_SELECTED_SKILLS", 3);

// --- Phase-2 feature flags (default OFF; opt-in per deployment) ---
// When false: long-term memory read+write+decay paths are short-circuited.
export const CLAW_MEMORY_ENABLED = envBool("CLAW_MEMORY_ENABLED", false);
// When false: skill selection, save, mutation, feedback, evolution, pattern
// recording, evolve worker, and skill-files cleanup are all short-circuited.
export const CLAW_SKILL_EVOLUTION_ENABLED = envBool("CLAW_SKILL_EVOLUTION_ENABLED", false);

/**
 * Chat (and queued-chat) dispatch publishes a doorbell and injects credentials
 * at claim time, instead of putting the full execute request on JetStream.
 *
 * Off by default: a rolling fleet must keep serving fat messages until every
 * Brain replica understands the doorbell. See packages/api/src/tasks/run-claim.ts.
 */
export const RUN_DOORBELL_DISPATCH = envBool("RUN_DOORBELL_DISPATCH", false);

/**
 * Cluster-wide admission ceilings. Zero means that dimension is not enforced.
 * Soft: further runs sit at `queued` for claim-next. Hard: the create is refused.
 * Counted by run-tree root so a recursive DAG cannot multiply a tenant's quota.
 */
export const ADMIT_SOFT_RUNS = envInt("ADMIT_SOFT_RUNS", 0, { min: 0 });
export const ADMIT_HARD_RUNS = envInt("ADMIT_HARD_RUNS", 0, { min: 0 });
export const ADMIT_SOFT_SANDBOXES = envInt("ADMIT_SOFT_SANDBOXES", 0, { min: 0 });
export const ADMIT_HARD_SANDBOXES = envInt("ADMIT_HARD_SANDBOXES", 0, { min: 0 });
export const ADMIT_SOFT_GPU_NODES = envInt("ADMIT_SOFT_GPU_NODES", 0, { min: 0 });
export const ADMIT_HARD_GPU_NODES = envInt("ADMIT_HARD_GPU_NODES", 0, { min: 0 });
export const ADMIT_TREE_MAX_NODES = envInt("ADMIT_TREE_MAX_NODES", 0, { min: 0 });
export const ADMIT_TREE_MAX_DEPTH = envInt("ADMIT_TREE_MAX_DEPTH", 0, { min: 0 });

// --- Skill evolution evidence sampling (E1) ---
// How many sole-skill exec_complete trajectories to feed the evolve LLM as evidence.
// Bad cases get more attention since they drive the change; good cases serve as a baseline.
export const EVOLVE_EVIDENCE_GOOD_COUNT = Number(env("EVOLVE_EVIDENCE_GOOD_COUNT", "3"));
export const EVOLVE_EVIDENCE_BAD_COUNT = Number(env("EVOLVE_EVIDENCE_BAD_COUNT", "4"));
