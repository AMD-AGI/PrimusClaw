// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import "dotenv/config";
import {
  DEFAULT_BRAIN_REGISTRY_TTL_MS,
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_TTL_MS,
  DEFAULT_SANDBOX_IDLE_REUSE_SECONDS,
  DEFAULT_TASK_MAX_ACK_PENDING,
  DEFAULT_TASK_MAX_DELIVER,
  isReasoningEffort,
  MIN_RENEWAL_INTERVAL_MS,
  parseAppContainerCaps,
  parseAppSandboxCaps,
  resolveLeaseReapGraceSec,
  resolveTaskDeliveryBudget,
  RUN_LEASE_HEARTBEATS_PER_TTL,
  type ReasoningEffort,
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

/** CLAW_ASSISTANT_ROUTER_EFFORT: an effort every provider takes, or null for `default`; anything else is reported and read as `default`. */
function routerEffortSetting(raw: string): ReasoningEffort | null {
  const v = raw.toLowerCase();
  if (v === "default") return null;
  if (isReasoningEffort(v)) return v;
  settingProblems.push(`CLAW_ASSISTANT_ROUTER_EFFORT=${raw} is not low, medium, high or default; using default`);
  return null;
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
/**
 * The SaFE workspace a sandbox starts in when a request names none. Brain reads the
 * same variable for the same purpose; the API reads it to name that workspace in
 * `GET /v1/me`, because the console sends whatever `sandbox.defaultWorkspaceId` says
 * with every turn and so overrides Brain's own default. Empty when not configured.
 */
export const SANDBOX_NAMESPACE = env("SANDBOX_NAMESPACE");
/**
 * The workspace for sandboxes that ask for no GPU, when a deployment has a separate one
 * (Brain's SANDBOX_CPU_NAMESPACE; see the Brain config for the rule). Then the workspace
 * sandboxes start in is this one, not SANDBOX_NAMESPACE, which becomes the GPU workspace:
 * `GET /v1/me` names this as the default, and Brain's own default is chosen per sandbox.
 * Empty when not configured.
 */
export const SANDBOX_CPU_NAMESPACE = env("SANDBOX_CPU_NAMESPACE");
/**
 * Management API of the Agent Sandbox control plane that `GET /v1/admin/sandbox/*`
 * lists for the console. Not SANDBOX_ROUTER_URL: that names the Router Brain
 * creates sandboxes through, which may sit in another cluster and expose only the
 * data plane. The default is the in-cluster Service the sandbox chart creates.
 */
export const SANDBOX_ADMIN_URL = env(
  "SANDBOX_ADMIN_URL",
  "http://agent-sandbox-router.agent-sandbox-system.svc.cluster.local:8080",
);

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

// --- Starting a session's sandbox without a turn ---
// `POST /v1/sessions/:id/sandbox` brings up (or reuses) the sandbox through the
// same run path a turn uses, so it asks for nothing a turn would not and is on
// by default; setting this false answers 404 as if the route did not exist,
// which clients treat as "not available" and fall back from.
export const SESSION_SANDBOX_START_ENABLED = envBool("SESSION_SANDBOX_START_ENABLED", true);
// How long one start or keepalive claims the sandbox for an interactive
// terminal. The claim lives in the registry bucket, whose entries are dropped
// after BRAIN_REGISTRY_TTL_MS without a write, so a longer claim would be
// forgotten early: the value is capped there, and renewing it is the client's
// job while the terminal stays open. A client that goes away stops renewing and
// the claim lapses on its own, after which ordinary idle reclaim applies.
export const SESSION_SANDBOX_HOLD_MS = Math.min(
  envInt("SESSION_SANDBOX_HOLD_SECONDS", 300, { min: 30 }) * 1000,
  BRAIN_REGISTRY_TTL_MS,
);

// --- The browser terminal ---
// `GET /v1/sessions/:id/terminal/ws` is a WebSocket proxy to the sandbox's shell,
// so every open terminal holds two sockets and a pod's pty for as long as it
// lives. These bound that per replica. A limit that is slightly loose across
// replicas still bounds the cost, which is all they are for.
//
// Connections: at most this many terminals open on one replica, in total and
// for one user. Past either, the upgrade is refused with 429.
export const TERMINAL_MAX_CONNECTIONS = envInt("TERMINAL_MAX_CONNECTIONS", 200, { min: 1, max: 100_000 });
export const TERMINAL_MAX_CONNECTIONS_PER_USER = envInt("TERMINAL_MAX_CONNECTIONS_PER_USER", 5, { min: 1, max: 1000 });
// A terminal with no input and no output in either direction for this long is
// closed. Pings do not count: they only prove the sockets are alive. Output does,
// so someone watching `top` is not cut off; a forgotten tab on `tail -f` is the
// lifetime's to end, below.
export const TERMINAL_IDLE_TIMEOUT_SECONDS = envInt("TERMINAL_IDLE_TIMEOUT_SECONDS", 900, { min: 10, max: 86_400 });
// No terminal stays open longer than this, whatever is going on in it: traffic
// does not extend it, which is what makes it a bound where the idle timeout
// above is not (output that never stops keeps a terminal from ever being idle).
// The shell holds the user's SaFE key, and nothing tells it that the key was
// revoked or the session deleted; the browser reconnects with a new ticket.
// There is no way to turn this off: 0, or anything outside 60 seconds to 7 days
// (604800), is refused -- the default applies, and start-up reports the setting
// as refused like any other -- because a switch that makes the shell open for as
// long as the browser likes is the thing this exists to prevent.
export const TERMINAL_MAX_LIFETIME_SECONDS = envInt("TERMINAL_MAX_LIFETIME_SECONDS", 28_800, { min: 60, max: 604_800 });

// --- How long an idle sandbox stays reusable ---
// Brain's setting, read here under the same name and default because the orphan
// sweep has to agree with Brain about when an idle sandbox stops being worth
// keeping: a sweep that reaps earlier than Brain would reclaim defeats the reuse
// window, one that reaps later only delays a reclaim Brain already owns. Both
// deployments take primus-claw-secrets, so one operator value reaches both.
//
// This is the capacity knob for parked sandboxes. Each one holds a workload slot
// for up to this long after the session's last turn; lowering it returns the slot
// sooner and makes more turns cold-start (10-15 s), raising it does the reverse.
export const SANDBOX_IDLE_REUSE_MS = envInt(
  "SANDBOX_IDLE_REUSE_SECONDS", DEFAULT_SANDBOX_IDLE_REUSE_SECONDS, { min: 1 },
) * 1000;

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

// There is deliberately no DAG_HANDLES_REPLICAS here, and the absence is the
// point: that bucket is brain's. Brain creates it in `sandbox/handles.ts` with
// `js.views.kv("DAG_HANDLES", { replicas: DAG_HANDLES_REPLICAS })`, and since
// `views.kv` attaches to a bucket that already exists and ignores the options
// it was handed, that one call is the only one in a cluster's lifetime that
// ever decides the bucket's replica count.
//
// Nothing in this package states an opinion about that configuration.
// `bindDagHandles` and `listDagHandles` attach with `bindOnly: true`, and
// DAG_HANDLES is kept out of the set that goes through `ensureKvBucket`
// (nats-stream-config.test.ts pins that it never arrives there). The reason is
// that `ensureKvBucket` corrects drift as well as creating: a count declared
// here would be written onto brain's bucket on every boot of this process, and
// on a cluster that came up api-first it would bring the bucket into existence
// with a number brain never chose. A bucket with one owner has one answer about
// its own configuration.
//
// The cost of that, spelled out because it is a cost and not a detail: no
// process corrects this bucket after brain brings it up -- not here, not there.
// DAG_HANDLES_REPLICAS has to be right in brain's environment the first time
// brain boots against a fresh cluster, and a count that was wrong then stays
// wrong until somebody deletes the bucket by hand. The comment that used to
// stand here claimed the opposite -- a reconcile on this side that no call in
// this package performs -- and it was cited on a sibling review to justify
// accepting a defect, which is what a fallback nobody implements is for. The
// same claim still sits in `infra/nats.ts` over DAG_HANDLES_BUCKET and in
// brain's `sandbox/handles.ts`, and is no truer in either place.

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
/** How long the download of a file the agent delivered (`deliver_file`) keeps working, counted from the delivery. */
export const DELIVERY_TTL_DAYS = envInt("DELIVERY_TTL_DAYS", 7, { min: 1 });
// Sweep cadence in minutes.
export const UPLOAD_SWEEP_INTERVAL_MIN = envInt("UPLOAD_SWEEP_INTERVAL_MIN", 60);

// --- Session auto-archive ---
// A session with no activity for this many days, and no run in flight, is
// archived by the daily maintenance pass. 0 disables it. Archiving only changes
// `claw_sessions.status`; the session stays readable and a new message to it
// makes it active again.
export const SESSION_AUTO_ARCHIVE_DAYS = envInt("SESSION_AUTO_ARCHIVE_DAYS", 7, { min: 0 });

// --- Archived-session retention ---
// An archived session is deleted this many days after it was archived, by the
// same daily pass and through the same deletion path as a user's delete (the
// conversation rows are stamped deleted, the S3 workspace and checkpoint
// prefixes are removed by the cleanup sweeper). 0 disables it. See
// sessions/retention.ts for which archived sessions are never taken.
export const SESSION_RETENTION_DAYS = envInt("SESSION_RETENTION_DAYS", 0, { min: 0 });
// The soft-deleted conversation rows of a session deleted more than this many
// days ago (turns, events, summaries) are removed for good. 0 disables it.
export const SESSION_PURGE_DAYS = envInt("SESSION_PURGE_DAYS", 0, { min: 0 });
// How many sessions retention deletes in a day, across all replicas (counted
// from the deletions of the last 24 hours, so restarts and more replicas do not
// multiply it), and separately how many deleted sessions one pass purges the
// rows of.
export const SESSION_RETENTION_BATCH = envInt("SESSION_RETENTION_BATCH", 500, { min: 1 });
// Count and log what the pass would delete and purge, and change nothing.
export const SESSION_RETENTION_DRY_RUN = envBool("SESSION_RETENTION_DRY_RUN", false);
// A pass that finds another replica (or a dead one's not yet dropped backend)
// holding the retention lock asks again after this many minutes, up to twelve
// times, instead of waiting for the next day.
export const SESSION_RETENTION_LOCK_RETRY_MIN = envInt("SESSION_RETENTION_LOCK_RETRY_MIN", 10, { min: 1 });
// One hold of the retention lock stops after this many seconds and the pass
// continues in a fresh hold half a minute later, until the day's batch is spent.
// Kept under the leader lock's ten-minute stall alarm.
export const SESSION_RETENTION_HOLD_BUDGET_SEC = envInt("SESSION_RETENTION_HOLD_BUDGET_SEC", 300, { min: 1 });

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
// When false: long-term memory read and write paths are short-circuited.
export const CLAW_MEMORY_ENABLED = envBool("CLAW_MEMORY_ENABLED", false);
// Long-term memory limits. The catalogue is what every turn of an opted-in user carries (one line per entry);
// a write past the entry limit is refused, never made room for by dropping another entry.
export const CLAW_MEMORY_MAX_ENTRIES = envInt("CLAW_MEMORY_MAX_ENTRIES", 100, { min: 1 });
export const CLAW_MEMORY_CATALOGUE_MAX_LINES = envInt("CLAW_MEMORY_CATALOGUE_MAX_LINES", 40, { min: 1 });
export const CLAW_MEMORY_CATALOGUE_MAX_TOKENS = envInt("CLAW_MEMORY_CATALOGUE_MAX_TOKENS", 1500, { min: 100 });
// Days after which a project / reference entry leaves the catalogue until the user confirms it again.
export const CLAW_MEMORY_PROJECT_REVIEW_DAYS = envInt("CLAW_MEMORY_PROJECT_REVIEW_DAYS", 30, { min: 1 });
export const CLAW_MEMORY_REFERENCE_REVIEW_DAYS = envInt("CLAW_MEMORY_REFERENCE_REVIEW_DAYS", 90, { min: 1 });
// When false: skill selection, save, mutation, feedback, evolution, pattern
// recording, evolve worker, and skill-files cleanup are all short-circuited.
export const CLAW_SKILL_EVOLUTION_ENABLED = envBool("CLAW_SKILL_EVOLUTION_ENABLED", false);

// When true: every turn that does the user's work (not an assistant Router turn) carries the
// general working guideline (sessions/agent-guideline.ts) in its system message.
export const CLAW_AGENT_GUIDELINE_ENABLED = envBool("CLAW_AGENT_GUIDELINE_ENABLED", false);

// --- Outbound notifications (default OFF) ---
// When false: no notification tables, routes, outbox writes or delivery loop.
export const CLAW_NOTIFICATIONS_ENABLED = envBool("CLAW_NOTIFICATIONS_ENABLED", false);
// Comma-separated hosts a subscription may name even though they resolve to a
// private address (an in-cluster receiver). The only hosts where http is accepted.
export const NOTIFY_WEBHOOK_ALLOWED_HOSTS = env("NOTIFY_WEBHOOK_ALLOWED_HOSTS");
// Comma-separated hosts an MCP server in a request's `mcp_servers` may name
// even though they resolve to a private address. The only hosts where http is
// accepted.
export const MCP_SERVER_ALLOWED_HOSTS = env("MCP_SERVER_ALLOWED_HOSTS");
// A run that is not trigger-started is announced only once it ran this long.
export const NOTIFY_MIN_RUN_SECONDS = envInt("NOTIFY_MIN_RUN_SECONDS", 60);
// Prefix of the `link` field in a notification, relative to the web UI origin.
export const NOTIFY_LINK_BASE = env("NOTIFY_LINK_BASE", "/primus-claw");
// The most `say` messages one user's assistant may send in an hour. A guard against a
// looping assistant, not a quota: a person is not meant to meet it.
export const CLAW_ASSISTANT_SAY_MAX_PER_HOUR = envInt("CLAW_ASSISTANT_SAY_MAX_PER_HOUR", 120, { min: 1 });

// --- Assistant (default OFF) ---
// When false: no assistant tables and no routes, as if the feature did not exist.
// One switch for every user: Claw has no per-user allow-list for it.
export const CLAW_ASSISTANT_ENABLED = envBool("CLAW_ASSISTANT_ENABLED", false);
// The model a user's router session asks for. Blank is the deployment default.
export const CLAW_ASSISTANT_ROUTER_MODEL = env("CLAW_ASSISTANT_ROUTER_MODEL");
// Work items one user may have unfinished (not on the done board) at once.
export const CLAW_ASSISTANT_MAX_ACTIVE_ITEMS = envInt("CLAW_ASSISTANT_MAX_ACTIVE_ITEMS", 20, { min: 1 });
// On-behalf GitHub reviews as work items of the assistant (`POST /v1/assistant/reviews`). Needs
// CLAW_ASSISTANT_ENABLED and CLAW_GITHUB_REVIEW_ENABLED as well; off, the routes do not exist.
export const CLAW_ASSISTANT_REVIEW_ITEMS = envBool("CLAW_ASSISTANT_REVIEW_ITEMS", false);
// `on` gives the assistant the user's long-term memory: the router a one-line index and the memory tools
// (recall, and save/update/forget/undo for a signed-in message that names the entry), a task item's worker a
// read-only index, a review item's session the entries bound to its item. Needs CLAW_ASSISTANT_ENABLED and
// CLAW_MEMORY_ENABLED as well; anything else leaves every assistant turn exactly as without memory.
export const CLAW_ASSISTANT_MEMORY_TOOLS = env("CLAW_ASSISTANT_MEMORY_TOOLS", "off").trim().toLowerCase() === "on";
// GitHub events for work items: an item watches a pull request, and new comments, reviews and failed CI
// reach its worker without anybody mentioning it (`assistant/github-events.ts`). Needs CLAW_ASSISTANT_ENABLED
// as well; off, there are no subscription routes, no tools for them and nothing polls.
export const CLAW_ASSISTANT_GITHUB_EVENTS = envBool("CLAW_ASSISTANT_GITHUB_EVENTS", false);
// How often a watched pull request is read. The time an event takes to reach its worker is at most this.
export const CLAW_ASSISTANT_GITHUB_POLL_SEC = envInt("CLAW_ASSISTANT_GITHUB_POLL_SEC", 30, { min: 10 });
// Pull requests one user's items may watch at once.
export const CLAW_ASSISTANT_GITHUB_MAX_SUBSCRIPTIONS = envInt("CLAW_ASSISTANT_GITHUB_MAX_SUBSCRIPTIONS", 20, { min: 1 });
// Bot accounts (such as `some-review-app[bot]`) whose comments on a watched pull request reach the worker. A bot has no
// permission on a repository to ask GitHub about, so without this every bot is held back; list only bots that do not
// repeat what others wrote. Comma-separated logins; empty by default.
export const CLAW_ASSISTANT_GITHUB_TRUSTED_BOTS: ReadonlySet<string> = new Set(
  env("CLAW_ASSISTANT_GITHUB_TRUSTED_BOTS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

// --- Remote agents (default OFF) ---
// When false: no remote-agent tables, no routes, and nothing polls. A connector
// on a user's machine dials out to these routes; see docs/remote-agents.md.
export const CLAW_REMOTE_AGENTS_ENABLED = envBool("CLAW_REMOTE_AGENTS_ENABLED", false);
// Days a closed remote-agent session, with its stored events, is kept. Zero or
// less keeps them for ever. The audit trail is not touched by this.
export const CLAW_REMOTE_AGENTS_RETENTION_DAYS = envInt("CLAW_REMOTE_AGENTS_RETENTION_DAYS", 30);

// --- GitHub pull request review (default OFF) ---
// When false: no tables, no routes, no MCP server offered to a session, and a session
// that asks for `config.acting_as` is refused. See docs/github-review.md.
export const CLAW_GITHUB_REVIEW_ENABLED = envBool("CLAW_GITHUB_REVIEW_ENABLED", false);

// --- GitHub tools for every session whose owner stored a GH_TOKEN (default OFF) ---
// When false: no route, and no `github` MCP server is offered to a session. See claw/docs/github-mcp.md.
export const CLAW_GITHUB_MCP_ENABLED = envBool("CLAW_GITHUB_MCP_ENABLED", false);

/**
 * How a connector's access token is checked (see auth/connector-token.ts). Read
 * on each use rather than once, so what a request is judged by is what the
 * environment says now; both only matter while remote agents and the identity
 * client are on.
 *
 *   CLAW_CONNECTOR_TOKEN_AUDIENCE    the `aud` the token must name, default claw-api
 *   CLAW_CONNECTOR_TOKEN_INTROSPECT  also ask the identity provider whether the
 *                                    token is still active, so a revoked grant
 *                                    stops at once instead of when the token expires
 */
export function connectorTokenSettings(): { audience: string; introspect: boolean } {
  return {
    audience: env("CLAW_CONNECTOR_TOKEN_AUDIENCE", "claw-api"),
    introspect: envBool("CLAW_CONNECTOR_TOKEN_INTROSPECT", false),
  };
}

/**
 * Scheduled triggers: a cron schedule that starts a run as the user who created
 * it. Off by default; when off no table is created, no route is registered and no
 * loop is started.
 */
export const CLAW_TRIGGERS_ENABLED = envBool("CLAW_TRIGGERS_ENABLED", false);
/** Smallest allowed gap between two firings of one schedule. */
export const TRIGGER_MIN_INTERVAL_MINUTES = envInt("TRIGGER_MIN_INTERVAL_MINUTES", 15, { min: 1 });
/** Triggers one user may own. */
export const TRIGGER_MAX_PER_USER = envInt("TRIGGER_MAX_PER_USER", 20, { min: 1 });
/** Runs one user's triggers may start in a rolling 24 hours. */
export const TRIGGER_DAILY_LIMIT_PER_USER = envInt("TRIGGER_DAILY_LIMIT_PER_USER", 100, { min: 1 });
/** How long a trigger-started run may take before the scheduler stops it. */
export const TRIGGER_RUN_TIME_LIMIT_SECONDS = envInt("TRIGGER_RUN_TIME_LIMIT_SECONDS", 1800, { min: 1 });
/** A planned firing older than this when the scheduler reaches it is skipped, not run late. */
export const TRIGGER_STALE_AFTER_SECONDS = envInt("TRIGGER_STALE_AFTER_SECONDS", 900, { min: 1 });
/** Consecutive failed starts before a trigger pauses itself. */
export const TRIGGER_MAX_CONSECUTIVE_FAILURES = envInt("TRIGGER_MAX_CONSECUTIVE_FAILURES", 3, { min: 1 });
/**
 * The model's own trigger tools (`trigger_create`, `trigger_list`, `trigger_cancel`), served by this API as an
 * MCP service and offered to every turn but a trigger's own runs. Needs CLAW_TRIGGERS_ENABLED. Off by default.
 */
export const CLAW_TRIGGER_TOOLS_ENABLED = envBool("CLAW_TRIGGER_TOOLS_ENABLED", false);
/** HMAC key of the bearer a turn presents to the trigger tools; at least 32 characters when they are on. */
export const CLAW_TRIGGER_TOOLS_TOKEN_KEY = env("CLAW_TRIGGER_TOOLS_TOKEN_KEY");

/**
 * Accept `mode: "app"` on `POST /v1/sessions/:sessionId/tasks`. Off by default:
 * until the Brain side runs apps, an admitted app run is refused there as not
 * implemented, so nothing is gained by taking one in.
 */
export const APP_RUNS_ENABLED = envBool("APP_RUNS_ENABLED", false);

/**
 * Whether the sandbox Router runs with `--enable-auth`. It decides what an
 * application's session-level MCP carries as `token` when a turn is dispatched:
 * with auth on, the `<SAFE_API_KEY>` placeholder, which Brain expands to the
 * session owner's platform key; with auth off, the run's MCP token. Must match
 * Brain's setting of the same name.
 */
export const SANDBOX_ROUTER_AUTH_ENABLED = envBool("SANDBOX_ROUTER_AUTH_ENABLED", false);

/**
 * Platform caps on what an app run's grant may carry, as JSON of the grant
 * shape: `{"max_sandboxes":8,"max_gpus":8,"gpu_hours":500,"max_runtime_sec":172800}`.
 * Each grant item is the smallest of the request, the manifest's limit (where it
 * has one) and its cap; an item with none of them is unbounded. A value that is not that shape stops start-up.
 */
export const APP_SANDBOX_CAPS = parseAppSandboxCaps(process.env.APP_SANDBOX_CAPS);

/**
 * The most one app container may ask for, as JSON: `{"gpus":8,"cpu":256,"memory_gi":4096}`.
 * An item left out keeps its default (one node: 8 GPUs, 256 cpu, 4096 GiB), so
 * "not configured" is never "unlimited": a pod asking for more GPUs than a node
 * has can never be scheduled and would hold the session's one app-run slot for
 * ever. A request above it is refused with a 400 naming the field. A value that is
 * not that shape stops start-up.
 */
export const APP_CONTAINER_CAPS = parseAppContainerCaps(process.env.APP_CONTAINER_CAPS);

/**
 * How long the grant service gets to answer `issue` (and `revoke`) before the
 * attempt counts as failed. The Idempotency-Key lock and its connection are held
 * for the whole call, so it must be bounded.
 */
export const APP_GRANT_ISSUE_TIMEOUT_MS = parseAppGrantTimeoutMs(process.env.APP_GRANT_ISSUE_TIMEOUT_MS, 10_000, "APP_GRANT_ISSUE_TIMEOUT_MS");

/**
 * After `issue` fails or times out, the grant service may still finish signing the
 * grant it was asked for, so the attempt's revoke is tried once more after this
 * long. The first revoke goes out at once (it covers the common case); this second
 * one covers a late signature. Past both, the grant lapses at its own expiry.
 */
export const APP_GRANT_REVOKE_RETRY_MS = parseAppGrantTimeoutMs(process.env.APP_GRANT_REVOKE_RETRY_MS, 30_000, "APP_GRANT_REVOKE_RETRY_MS");

/**
 * A whole number of milliseconds between 1000 and 300000, or start-up fails: 0 or a
 * negative value would time every grant call out at once and make every app run a
 * 503, and a huge one would hold the Idempotency-Key lock for as long.
 */
export function parseAppGrantTimeoutMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1_000 || n > 300_000) {
    throw new Error(`${name} must be a whole number of milliseconds between 1000 and 300000, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Chat (and queued-chat) dispatch publishes a doorbell and injects credentials
 * at claim time, instead of putting the full execute request on JetStream.
 *
 * On by default. The capability floor keeps each API on fat dispatch until the
 * fleet explicitly asserts support for this binary's semantics version.
 */
export const RUN_DOORBELL_DISPATCH = envBool("RUN_DOORBELL_DISPATCH", true);

/**
 * The deployment's assertion that every Brain able to receive `tasks.execute`
 * takes a durable SQL holder before its execution gate.
 *
 * Not a switch over one sweeper pass: it is the first evidence arm of the
 * shared no-delivery guard, and asserting it does not adjust the other arms but
 * makes them irrelevant -- every unheld fat row becomes eligible on the
 * assertion alone, whatever its receipt says and whether or not the durable can
 * be read. `reconcile-on-fleet-arm.test.ts` is what that means, stated.
 *
 * On by default, which is a statement about the deployment this default is
 * written for and not about any deployment. Enabling it before every API
 * replica and every Brain is new -- and before the longest delayed in-process
 * callback an old replica can have armed has expired -- lets a reaper close a
 * delivery that is about to execute. A fleet rolling up from a release that
 * predates the durable holder must therefore set this to `false` for the
 * duration of the rollout and unset it afterwards; the off-side suites
 * (`reconcile-off-*.test.ts`, `doorbell-gate-ownership-legacy.test.ts`, and the
 * receipt and settlement suites that name it in their headers) are what that
 * configuration still owes, and they declare it rather than inherit it.
 */
export const RUN_FAT_PREPARING_RECONCILE = envBool("RUN_FAT_PREPARING_RECONCILE", true);

/**
 * Cluster-wide admission ceilings. Zero means that dimension is not enforced.
 * Soft: further runs sit at `queued` for claim-next. Hard: the create is refused.
 *
 * Fleet-wide, not a per-tenant quota: `claw_tasks` carries no owner column.
 * Only the run dimension is keyed by run-tree root; sandboxes count per row and
 * GPU nodes sum per row, so a 20-node DAG is one run root and up to twenty
 * sandbox units.
 */
// Strict where `envInt`'s defaults are dangerous: both a blank line and a
// fractional value would otherwise degrade to the fallback `0`, which is the
// value that means "not enforced" and the one a `> 0` test never sees.
const ADMIT_BOUNDS = { min: 0, wholeNumbersOnly: true, blankIsRefused: true } as const;

export const ADMIT_SOFT_RUNS = envInt("ADMIT_SOFT_RUNS", 0, ADMIT_BOUNDS);
export const ADMIT_HARD_RUNS = envInt("ADMIT_HARD_RUNS", 0, ADMIT_BOUNDS);
export const ADMIT_SOFT_SANDBOXES = envInt("ADMIT_SOFT_SANDBOXES", 0, ADMIT_BOUNDS);
export const ADMIT_HARD_SANDBOXES = envInt("ADMIT_HARD_SANDBOXES", 0, ADMIT_BOUNDS);
export const ADMIT_SOFT_GPU_NODES = envInt("ADMIT_SOFT_GPU_NODES", 0, ADMIT_BOUNDS);
export const ADMIT_HARD_GPU_NODES = envInt("ADMIT_HARD_GPU_NODES", 0, ADMIT_BOUNDS);
export const ADMIT_TREE_MAX_NODES = envInt("ADMIT_TREE_MAX_NODES", 0, ADMIT_BOUNDS);
export const ADMIT_TREE_MAX_DEPTH = envInt("ADMIT_TREE_MAX_DEPTH", 0, ADMIT_BOUNDS);

const ADMIT_CEILINGS: ReadonlyArray<readonly [string, number]> = [
  ["ADMIT_SOFT_RUNS", ADMIT_SOFT_RUNS],
  ["ADMIT_HARD_RUNS", ADMIT_HARD_RUNS],
  ["ADMIT_SOFT_SANDBOXES", ADMIT_SOFT_SANDBOXES],
  ["ADMIT_HARD_SANDBOXES", ADMIT_HARD_SANDBOXES],
  ["ADMIT_SOFT_GPU_NODES", ADMIT_SOFT_GPU_NODES],
  ["ADMIT_HARD_GPU_NODES", ADMIT_HARD_GPU_NODES],
  ["ADMIT_TREE_MAX_NODES", ADMIT_TREE_MAX_NODES],
  ["ADMIT_TREE_MAX_DEPTH", ADMIT_TREE_MAX_DEPTH],
];

// With the doorbell off the metered paths are the batch ones, so an operator
// setting a ceiling would meter DAG and task work while interactive chat
// bypasses it entirely -- not a fleet ceiling at all.
for (const [key, value] of ADMIT_CEILINGS) {
  if (value > 0 && !RUN_DOORBELL_DISPATCH) {
    reportSettingProblem(
      `${key}=${value} requires RUN_DOORBELL_DISPATCH=true; `
      + `with the doorbell off, chat dispatch is not admitted and the ceiling is not a fleet ceiling`,
    );
  }
}

// A soft ceiling above its hard ceiling can never fire, the hard refusal being
// evaluated first, so the operator's queueing threshold is silently dead.
for (const [softKey, soft, hardKey, hard] of [
  ["ADMIT_SOFT_RUNS", ADMIT_SOFT_RUNS, "ADMIT_HARD_RUNS", ADMIT_HARD_RUNS],
  ["ADMIT_SOFT_SANDBOXES", ADMIT_SOFT_SANDBOXES, "ADMIT_HARD_SANDBOXES", ADMIT_HARD_SANDBOXES],
  ["ADMIT_SOFT_GPU_NODES", ADMIT_SOFT_GPU_NODES, "ADMIT_HARD_GPU_NODES", ADMIT_HARD_GPU_NODES],
] as ReadonlyArray<readonly [string, number, string, number]>) {
  if (soft > 0 && hard > 0 && soft > hard) {
    reportSettingProblem(
      `${softKey}=${soft} is above ${hardKey}=${hard}, so it can never defer a run the hard ceiling admits`,
    );
  }
}

/** Refused `ADMIT_*` settings, selected by the key prefix every message begins with. */
export function admissionSettingProblems(): readonly string[] {
  return envSettingProblems().filter((problem) => problem.startsWith("ADMIT_"));
}

/**
 * Refuse to boot on any malformed or unenforceable admission ceiling.
 *
 * Fatal rather than logged because every degraded `ADMIT_*` value is `0`, which
 * silently switches off the dimension the operator was tightening.
 *
 * @param log the caller's logger; this module has none of its own, constants
 *   here being evaluated before one exists.
 * @throws when any `ADMIT_*` setting was refused.
 */
export function assertAdmissionSettings(
  log: { error: (obj: object, msg: string) => void },
): void {
  const problems = admissionSettingProblems();
  if (!problems.length) return;
  log.error({ problems }, "startup.admission_settings_refused");
  throw new Error(`refused admission settings: ${problems.join("; ")}`);
}

// --- Skill evolution evidence sampling (E1) ---
// How many sole-skill exec_complete trajectories to feed the evolve LLM as evidence.
// Bad cases get more attention since they drive the change; good cases serve as a baseline.
export const EVOLVE_EVIDENCE_GOOD_COUNT = Number(env("EVOLVE_EVIDENCE_GOOD_COUNT", "3"));
export const EVOLVE_EVIDENCE_BAD_COUNT = Number(env("EVOLVE_EVIDENCE_BAD_COUNT", "4"));

// --- Assistant: router and worker turns (the switch itself is CLAW_ASSISTANT_ENABLED) ---
// HMAC key of the bearer a router or worker turn presents to the assistant MCP service.
// Required, 32 characters at least, whenever the assistant is on: a deployment without
// it refuses to start rather than mint turns nobody can authenticate.
export const CLAW_ASSISTANT_TOKEN_KEY = env("CLAW_ASSISTANT_TOKEN_KEY");
// The model a work item's worker turns ask for. Blank is the worker session's own choice.
export const CLAW_ASSISTANT_WORKER_MODEL = env("CLAW_ASSISTANT_WORKER_MODEL");
// LLM calls a router turn may make. A router only classifies, calls a tool and says one line.
export const CLAW_ASSISTANT_ROUTER_MAX_TURNS = envInt("CLAW_ASSISTANT_ROUTER_MAX_TURNS", 8, { min: 1 });
// How hard a router turn's model thinks (`ExecuteRequest.effort`): low, medium or high, or `default` (the default) for the model's own.
// Thinking is most of a router turn's time on a reasoning model, so `low` makes it quicker (`assistant/router-speed.ts`); it is not the
// default because a model that takes no reasoning effort (an OpenAI-style deployment's gpt-4o) refuses a request that names one. A
// session that chose an effort of its own keeps it.
export const CLAW_ASSISTANT_ROUTER_EFFORT = routerEffortSetting(env("CLAW_ASSISTANT_ROUTER_EFFORT", "default"));
// `false` stops publishing a router's `say` while the model writes it (`ExecuteRequest.stream_tool_text`, `toolTextDelta` events): a
// channel that follows the turn shows the words as they come instead of when the step ends.
export const CLAW_ASSISTANT_STREAM_SAY = envBool("CLAW_ASSISTANT_STREAM_SAY", true);
// `true` lets a router's `say` cite where its answer came from (`assistant/citations.ts`): the model writes [1], [2] in the text and
// names each number's address in `sources`; Brain keeps only addresses this turn's lookups returned, and an `assistant.say` carries
// them as `sources` for the channel to show. Off (the default): no `sources` on `say`, and the prompt asks for links in the text.
export const CLAW_ASSISTANT_CITATIONS = envBool("CLAW_ASSISTANT_CITATIONS", false);
// How long an item may need the user with nobody having told them before the system tells them.
export const CLAW_ASSISTANT_SILENT_SWEEP_SEC = envInt("CLAW_ASSISTANT_SILENT_SWEEP_SEC", 300, { min: 1 });
// `on` gives the router the review and settings tools (review_start, review_restart, confirmation_answer,
// review_mode_set, channel_action); anything else leaves it the five tools of a conversation.
export const CLAW_ASSISTANT_TOOLS = env("CLAW_ASSISTANT_TOOLS", "off").trim().toLowerCase() === "on";
// The marketplace plugin whose MCP servers the assistant reads from and its workers run with, when the message names
// none (a chat client that talks to the assistant sends no plugin). Blank or 0: none, and a router turn has no read tools.
// A router turn is offered only the read tools `assistant/read-tools.ts` lists of it; a worker gets the whole plugin.
export const CLAW_ASSISTANT_PLUGIN_ID = envInt("CLAW_ASSISTANT_PLUGIN_ID", 0, { min: 0 });
// How long after the assistant received a signed-in message a turn answering it may still act for the person.
export const CLAW_ASSISTANT_ATTENDED_TTL_SEC = envInt("CLAW_ASSISTANT_ATTENDED_TTL_SEC", 600, { min: 1 });
// Group chats and repositories the assistant watches, recording what it would do without doing it
// (`assistant/observe.ts`). Off: the routes do not exist. Needs CLAW_ASSISTANT_ENABLED.
export const CLAW_ASSISTANT_OBSERVE = envBool("CLAW_ASSISTANT_OBSERVE", false);
// How long an item in progress may go without any sign of progress before the watchdog puts it in front of
// its owner, with the reason (`assistant/watchdog.ts`). 0 is off.
export const CLAW_ASSISTANT_WATCHDOG_SEC = envInt("CLAW_ASSISTANT_WATCHDOG_SEC", 0, { min: 0 });
// Model choice for the assistant's items (`assistant/model-choice.ts`): an item's model asked for in the message, the user's
// own defaults, an allow-list, and a fallback when the payer's key cannot use a model. `on` turns it on; anything else (the
// default) leaves every tool, prompt, table and turn exactly as without it. An empty CLAW_ASSISTANT_MODELS is the same as off.
export const CLAW_ASSISTANT_MODEL_CHOICE = ["on", "true", "1", "yes"].includes(env("CLAW_ASSISTANT_MODEL_CHOICE", "off").toLowerCase());
// The models a user may pick, comma-separated, each with the label the assistant and the settings show:
// `claude-opus-5.5=strongest,claude-sonnet-5.5=default`. A name without `=label` has no label.
export const CLAW_ASSISTANT_MODELS = env("CLAW_ASSISTANT_MODELS");
// The model a review item runs on when neither the request nor the reviewer's own settings name one. Blank is the
// deployment default (DEFAULT_MODEL). Read only with CLAW_ASSISTANT_MODEL_CHOICE on.
export const CLAW_ASSISTANT_REVIEW_MODEL = env("CLAW_ASSISTANT_REVIEW_MODEL");
// The model an item falls back to when the payer's key cannot use the one chosen, and the model a turn the gateway refused for
// want of a key binding is run again on, once. It must be in CLAW_ASSISTANT_MODELS; blank means no fallback.
export const CLAW_FALLBACK_MODEL = env("CLAW_FALLBACK_MODEL");
// Where a user binds the key the gateway asked for, named in the notice of a turn run again on the fallback model. Optional.
export const CLAW_ASSISTANT_KEY_BINDING_URL = env("CLAW_ASSISTANT_KEY_BINDING_URL");
// The deployment's default model as Brain reads it (the same shared setting): what a turn runs on when nothing names one.
export const ASSISTANT_DEPLOYMENT_MODEL = env("DEFAULT_MODEL");
// The address Brain reaches this API at; the assistant MCP service is served under it.
export const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;
