// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * ensureHands / ensureHandsAgentSandbox — provision (or reuse) a session's
 * Hands sandbox. Workload create/poll follows the original Python sandbox
 * executor's `_create_workload` (images + resources
 * + merged env); resource rows come from the API task payload. GPU templates
 * are expected to be pre-registered via plugin/catalog flow; brain does not
 * auto-create them.
 */
import { randomBytes } from "node:crypto";
import { webcrypto } from "node:crypto";
import { StringCodec } from "nats";
import pino from "pino";
import { composeSandboxEnv } from "@claw/protocol";
import type { ExecuteRequest } from "@claw/protocol";
import { isRevisionConflict, sleep } from "@claw/utils";
import { isTombstone, pickLockKey } from "../tasks/lock.js";
import {
  HANDS_MCP_URL, SAFE_API_URL, SANDBOX_NAMESPACE, AUTH_INTERNAL_TOKEN,
  ANTHROPIC_BASE_URL, OPENAI_BASE_URL, isKubernetesMode, AGENT_SANDBOX_NAMESPACE,
  HANDS_HEALTH_MAX_TRIES, HANDS_HEALTH_INTERVAL_MS,
} from "../config.js";
import { getSystemEnv } from "../infra/system-env.js";
import { resolveRequestLlmKey } from "../llm/key-source.js";
import { checkHandsHealth } from "./hands-health.js";
import { destroyHands } from "./reaper.js";
import {
  resolveSandboxAction,
  resourcesMapToWorkloadArray,
  assertImageDigest,
  applyMultiNodeExternalEnv,
} from "./params.js";
import type { SandboxAction } from "./params.js";
import { resourcesJsonToWorkloadArray } from "./workload-resources.js";
import type { MultiNodeContext } from "./multi-node/types.js";
import { writeSandboxSshKey } from "./multi-node/sandbox-key.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import { lookupDagHandle, registerDagHandle } from "./handles.js";
import { getHandsKv, registerHandsToken } from "./registry.js";
import { bootstrapHandsInSandbox } from "./bootstrap.js";
import { restartHandsInSandbox } from "./hands-restart.js";
import { registerSandbox } from "./keepalive.js";
import type { SandboxEntry } from "./keepalive.js";
import {
  parseHandsProbeValue,
  probeSandboxContainer,
  sameHandsSandbox,
  type ContainerProbeOutcome,
  type HandsProbeEntry,
} from "./container-probe.js";
import { sandboxSpecFingerprint, evaluateReuse } from "./spec-fingerprint.js";
import { metrics } from "../infra/metrics.js";

const logger = pino({ name: "ensure-hands" });
const sc = StringCodec();
/** Idle TTL create falls back to when the spec names none. */
const DEFAULT_SANDBOX_TTL_SEC = 10;
const SANDBOX_IMAGE_RE = /(?:^|\s)sandboximage:\s*(\S+)/im;

export function resolveSandboxImageFromRequest(request: ExecuteRequest): string {
  const direct = String(request.sandbox_image ?? "").trim();
  if (direct) return direct;
  const fromPrompt = SANDBOX_IMAGE_RE.exec(String(request.prompt ?? ""))?.[1]?.trim();
  return fromPrompt || "";
}

/**
 * Coerce a request's `timeout` into positive whole seconds, or undefined.
 *
 * Shared with the multi-node provider so a GPU cluster expires on the same
 * business timeout as the sandbox that drives it.
 */
export function normalizeWorkloadTimeout(timeout: unknown): number | undefined {
  if (timeout === undefined || timeout === null || String(timeout).trim() === "") return undefined;
  const parsed = Number(timeout);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : undefined;
}

export interface EnsureHandsResult {
  handsUrl: string;
  /** True only when this call created a fresh workload; false when reusing
   *  a cached healthy one. Callers use this to decide whether to rehydrate
   *  the sandbox workspace from S3. */
  created: boolean;
  /** Per-sandbox bearer token. A freshly generated 256-bit random string when
   *  a new workload is created; the previously stored value when reusing a
   *  healthy cached sandbox; local-dev (HANDS_MCP_URL) mode requires
   *  AUTH_INTERNAL_TOKEN explicitly and fails when missing. */
  token: string;
  /**
   * Which sandbox this actually is, for callers that later need to reach it
   * without going through `hands.<sessionId>`.
   *
   * That key is per session, and a DAG gives every one of its nodes the same
   * session -- so a node asking "is my sandbox alive" through it gets an answer
   * about whichever sibling wrote it last, and a node asking to destroy its
   * sandbox through it destroys that sibling's. Carrying the identity out of
   * here is what lets the recovery path address the sandbox it was actually
   * given. Absent in local-dev mode, where there is no workload to name.
   */
  identity?: HandsProbeEntry;
}

/**
 * The resources create will really use, from whichever of its two sources wins.
 *
 * The resolved spec's map when it has anything in it, the request's own legacy
 * chat field when it does not. Shared with the fingerprint rather than restated
 * there: reading only the first is wrong on the prompt-scan fallback below,
 * which synthesises an action with an empty map while create goes on honouring
 * `request.resources` -- so every request on that path would fingerprint alike
 * and a resource change would never rebuild.
 */
function effectiveWorkloadResources(
  request: ExecuteRequest,
  params: { resources: Record<string, string> },
): Array<Record<string, string | number>> | null {
  return Object.keys(params.resources).length > 0
    ? resourcesMapToWorkloadArray(params.resources)
    : resourcesJsonToWorkloadArray(request.resources);
}

/**
 * Condense a request into the spec its sandbox will be built to.
 *
 * One definition for the comparison and both write sites, because a fingerprint
 * assembled differently in two places is a fingerprint that never matches.
 *
 * The two providers do not read the request identically -- SaFE falls back to
 * the legacy chat fields for resources and timeout and applies a TTL default,
 * agent-sandbox takes only what the resolved spec carries and passes no TTL at
 * all -- so this asks whichever one is configured. A fingerprint written
 * against one provider is wrong on the other in both directions: it misses a
 * change that does reach create, and it rebuilds for a field create ignores.
 *
 * Defaults are applied here too: an omitted `ttl_sec` and an explicit ten
 * describe the same sandbox, so they have to fingerprint the same.
 */
export function requestSpecFingerprint(
  request: ExecuteRequest,
  action: Extract<SandboxAction, { kind: "create" }>,
): string {
  const kubernetes = isKubernetesMode();
  // The same composition the sandbox is actually built from, minus the layers
  // that are not per-request: a key the deny list drops never reaches the pod,
  // so folding the raw request layers in here would rebuild a sandbox over an
  // env change that the sandbox could not have observed. `systemEnv` is left
  // out because it is deployment-wide -- reading it here would make every
  // request's fingerprint depend on a value no request can change.
  const env = composeSandboxEnv({
    base: action.params.env ?? {},
    userEnv: request.user_env,
    sessionEnv: request.session_env,
  });
  const labels = action.params.labels ?? {};
  const namespace = sandboxNamespaceFor(request);
  if (kubernetes) {
    return sandboxSpecFingerprint({
      image: action.params.image,
      resources: action.params.resources,
      env,
      // No `timeout` here, unlike the SaFE branch below: the agent-sandbox
      // provider never reads `params.timeout`, so a request that changes it
      // produces a pod identical to the one already running, and folding it in
      // would throw that sandbox away to build its twin.
      labels,
      namespace,
      // The caller's own key in this mode, injected at create under the
      // conventional Anthropic/OpenAI names and never reloaded -- so a
      // rotation only reaches the sandbox by rebuilding it. safe mode
      // authenticates with the deployment's platform key instead, which is
      // not per-request and so is not folded in there.
      llmKey: resolveRequestLlmKey(request),
    });
  }
  const resources: Record<string, string> = {};
  for (const entry of effectiveWorkloadResources(request, action.params) ?? []) {
    for (const [k, v] of Object.entries(entry)) resources[k] = String(v);
  }
  return sandboxSpecFingerprint({
    image: action.params.image,
    resources,
    env,
    timeout: action.params.timeout ?? normalizeWorkloadTimeout(request.timeout),
    ttlSec: action.params.ttl_sec ?? DEFAULT_SANDBOX_TTL_SEC,
    labels,
    namespace,
  });
}

/**
 * The namespace this request's pod is created in.
 *
 * `workspace_id` is session-scoped and picked by the caller; the env is the
 * deployment-wide fallback for clients that have not migrated, and which env
 * depends on the provider. Must agree with the workload body, the Hands DNS
 * name, the SaFE exec URL and the KV entry keepalive reads back -- and with the
 * fingerprint, since a pod cannot move namespace after it is scheduled.
 */
function sandboxNamespaceFor(request: ExecuteRequest): string {
  const fallback = isKubernetesMode() ? AGENT_SANDBOX_NAMESPACE : SANDBOX_NAMESPACE;
  return request.workspace_id?.trim() || fallback;
}

/**
 * What deciding against reuse does to the world, besides answering.
 *
 * Bound rather than called through the imports directly, so the gates below can
 * be exercised without a cluster: `destroyHands` reaches for the KV bucket and
 * the workload API, and `registerSandbox` starts a keepalive ticker. Neither is
 * what the decision is about, and both are what a test of it would otherwise
 * have to stand up.
 */
export interface SandboxReuseEffects {
  destroyHands: (
    sessionId: string,
    known?: HandsProbeEntry,
    knownToken?: string,
  ) => Promise<void>;
  registerSandbox: typeof registerSandbox;
  probeSandboxContainer: (
    sessionId: string,
    known?: HandsProbeEntry,
    signal?: AbortSignal,
  ) => Promise<ContainerProbeOutcome>;
  restartHandsInSandbox: typeof restartHandsInSandbox;
}

export interface EnsureHandsOptions {
  /**
   * Provision instead of consulting `hands.<sessionId>`.
   *
   * Recovery uses this after stopping a specifically named DAG sandbox. The
   * shared session key may still name a live sibling, which must neither be
   * reused as the replacement nor have its workspace overwritten.
   */
  skipSessionReuse?: boolean;
  /**
   * Cancels the probe and restart the reuse path may run.
   *
   * Those two are the only slow I/O here that outlives a decision: together
   * they can hold a cancelled run for the probe deadline plus a full restart,
   * kill-and-relaunching Hands inside a container another replica may already
   * be tearing down. task-runner passes its run signal; callers with nothing to
   * cancel pass none.
   */
  signal?: AbortSignal;
}

const realReuseEffects: SandboxReuseEffects = {
  destroyHands, registerSandbox, probeSandboxContainer, restartHandsInSandbox,
};
let reuseEffects: SandboxReuseEffects = realReuseEffects;

/** Override the two effects above; returns the call that puts them back. */
export function bindSandboxReuseEffects(
  overrides: Partial<SandboxReuseEffects>,
): () => void {
  reuseEffects = { ...realReuseEffects, ...overrides };
  return () => { reuseEffects = realReuseEffects; };
}

const REUSE_HEALTH_TIMEOUT_MS = 5000;

/**
 * Fail a `use` node whose inherited sandbox is no longer answering.
 *
 * Throwing rather than provisioning a replacement: `use` means "the sandbox an
 * upstream node built", and quietly handing back a different one would lose
 * whatever that node left on its disk.
 */
export async function assertDagHandleAlive(
  handle: string,
  dagRoot: string,
  sessionId: string,
  handsUrl: string,
  identity?: SandboxEntry,
  token?: string,
  signal?: AbortSignal,
): Promise<void> {
  const health = await checkHandsHealth(handsUrl, REUSE_HEALTH_TIMEOUT_MS, signal);
  if (health.ok) return;
  if (identity && token) {
    const probe = await reuseEffects.probeSandboxContainer(sessionId, identity, signal);
    if (probe.verdict === "alive") {
      const restarted = await reuseEffects.restartHandsInSandbox({
        sessionId,
        handsUrl,
        token,
        entry: identity,
        signal,
      });
      if (restarted.ok) return;
      // A node that inherited this sandbox cannot rebuild it (see the throw
      // below and inheritedSandboxHandle), so a refusal here has no fallback
      // to offer -- but it must still say which of the two happened, or the
      // operator reads "could not restart" and goes looking for a crash.
      throw new Error(
        restarted.refused
          ? `sandbox_spec.use='${handle}' in-place Hands restart is unavailable in `
            + `this deployment (${restarted.detail}), and a node cannot rebuild a `
            + `sandbox it inherited (dag ${dagRoot}). Re-run the node that created `
            + `this handle.`
          : `sandbox_spec.use='${handle}' Hands could not restart in its live sandbox `
            + `(dag ${dagRoot}): ${restarted.detail}`,
      );
    }
    if (probe.verdict === "unknown") {
      throw new Error(
        `sandbox_spec.use='${handle}' could not confirm its sandbox state `
        + `(dag ${dagRoot}): ${probe.reason}. The sandbox was left intact.`,
      );
    }
  }
  throw new Error(
    `sandbox_spec.use='${handle}' points at a sandbox that is not responding `
    + `(dag ${dagRoot}, ${handsUrl}): ${health.detail}. The node that created `
    + `this handle has probably lost its sandbox.`,
  );
}

export interface ReuseAttempt {
  kv: ReturnType<typeof getHandsKv>;
  sessionId: string;
  request: ExecuteRequest;
  multiNodeContext?: MultiNodeContext;
  requestedSpec: string;
  onEvent: (evt: Record<string, unknown>) => Promise<void>;
  signal?: AbortSignal;
}

function reuseIdentity(info: any): SandboxEntry {
  return {
    provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
    workloadId: info.workloadId,
    platformKey: info.platformKey || "",
    sessionId: info.sessionId,
    sandboxName: info.sandboxName,
    namespace: info.namespace,
    userId: info.userId,
  };
}

async function recoverUnhealthyReuse(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  identity: SandboxEntry,
  revision: number,
  signal?: AbortSignal,
): Promise<EnsureHandsResult | null> {
  const probe = await reuseEffects.probeSandboxContainer(sessionId, identity, signal);
  if (probe.verdict === "dead") return null;
  if (probe.verdict === "unknown") {
    logger.warn(
      { sessionId, handsUrl: info.handsUrl, verdict: probe.verdict, reason: probe.reason },
      "ensureHands.mcp_unhealthy_container_kept",
    );
    throw new Error(
      `Hands is unavailable and container state is unknown (${probe.reason}); `
      + "the sandbox was left intact",
    );
  }

  const restarted = await reuseEffects.restartHandsInSandbox({
    sessionId,
    handsUrl: info.handsUrl,
    token: info.token,
    entry: identity,
    signal,
  });
  if (!restarted.ok) {
    // A refusal is not a failed repair. It says this deployment will never
    // restart Hands in place here -- the kill switch is off, or the pooled
    // pod's environment cannot be reproduced -- so keeping the container means
    // every later turn on this session fails the same way with no way out.
    // Returning null hands the caller back to the replace-and-rebuild path it
    // used before the in-place restart existed, which is what the operator who
    // turned the switch off asked for.
    if (restarted.refused) {
      logger.warn(
        { sessionId, handsUrl: info.handsUrl, detail: restarted.detail },
        "ensureHands.restart_refused_rebuilding",
      );
      return null;
    }
    throw new Error(
      `Hands is unavailable (${restarted.detail}); the live sandbox was left intact`,
    );
  }
  logger.warn(
    { sessionId, handsUrl: info.handsUrl, detail: restarted.detail },
    "ensureHands.mcp_restarted_in_place",
  );
  return acceptExistingSandbox(kv, sessionId, info, identity, revision);
}

async function readReusableEntry(
  kv: ReuseAttempt["kv"],
  sessionId: string,
): Promise<{ entry: NonNullable<Awaited<ReturnType<typeof kv.get>>>; info: any } | null> {
  let entry: Awaited<ReturnType<typeof kv.get>>;
  try {
    entry = await kv.get(`hands.${sessionId}`);
  } catch (cause) {
    throw new Error("hands KV is unavailable; refusing unsafe sandbox replacement", { cause });
  }
  // A deleted key still reads back, as an entry with an empty value. That is
  // the opposite of the case the throw below exists for: nothing is left to
  // replace unsafely, so this is the ordinary "no sandbox yet" answer and the
  // caller builds one. Reading it as corrupt instead made every turn of a
  // session whose sandbox had just been torn down fail outright, for as long
  // as the tombstone lived, where the code this replaced recovered.
  if (!entry || isTombstone(entry)) return null;
  try {
    return { entry, info: parseHandsProbeValue(sc.decode(entry.value)) };
  } catch (cause) {
    logger.warn({ sessionId }, "ensureHands.kv_entry_unreadable");
    throw new Error("hands KV entry is corrupt; refusing unsafe sandbox replacement", { cause });
  }
}

/**
 * Hand back the session's existing sandbox when it is both alive and built to
 * the spec being asked for; otherwise tear it down so the caller can rebuild.
 *
 * Liveness alone used to be the whole test, which meant a user who changed the
 * image or the resources and sent another message silently got the old sandbox
 * back with no indication anything had been ignored.
 */
export async function tryReuseSessionSandbox(a: ReuseAttempt): Promise<EnsureHandsResult | null> {
  const { kv, sessionId, request, multiNodeContext, requestedSpec, onEvent, signal } = a;
  logger.info({ sessionId }, "ensureHands.kv_lookup");
  const recorded = await readReusableEntry(kv, sessionId);
  if (!recorded) return null;
  const { entry, info } = recorded;

  logger.info(
    { sessionId, status: info.status, workloadId: info.workloadId, handsUrl: info.handsUrl },
    "ensureHands.kv_entry_found",
  );
  const identity = reuseIdentity(info);
  const hasToken = typeof info.token === "string" && info.token.length > 0;

  // Multi-node bakes cluster env at sandbox create; hands never reloads env.
  // Always replace any prior sandbox (single- or multi-node) with a fresh one.
  if (multiNodeContext) {
    logger.info(
      {
        sessionId,
        messageId: request.message_id ?? null,
        priorWorkloadId: info.workloadId ?? null,
        priorStatus: info.status ?? null,
      },
      "ensureHands.mn_replace_sandbox",
    );
    await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    return null;
  }

  if (info.status !== "ready") {
    logger.warn(
      { sessionId, workloadId: info.workloadId, status: info.status ?? "(none)" },
      "hands.kv.stale_pending_found",
    );
    await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    return null;
  }

  const verdict = evaluateReuse(info.specFingerprint, requestedSpec);
  if (!verdict.reuse) {
    logger.info(
      { sessionId, recorded: verdict.recorded, requested: verdict.requested },
      "ensureHands.spec_changed_rebuilding",
    );
    // Told rather than merely logged: from the outside a rebuild looks like an
    // unexplained slow turn, and the cause is something the user just did.
    await onEvent({
      type: "sandboxStatus",
      event: "rebuild",
      status: "recreating",
      reason: "spec_changed",
      detail: "the sandbox image, resources or environment differ from the running sandbox",
    }).catch(() => {});
    await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    return null;
  }

  const health = await checkHandsHealth(info.handsUrl as string, REUSE_HEALTH_TIMEOUT_MS, signal);
  if (health.ok && hasToken) {
    logger.info(
      { sessionId, handsUrl: info.handsUrl, specMatch: verdict.reason },
      "ensureHands.reusing_existing",
    );
    return acceptExistingSandbox(kv, sessionId, info, identity, entry.revision);
  }
  // Both ways of failing the gate, named apart: a sandbox that did not answer
  // is a different operational story from one that answered and has no token to
  // talk to it with.
  logger.warn(
    { sessionId, health: health.detail, hasToken },
    health.ok ? "ensureHands.health_ok_but_unusable" : "ensureHands.health_check_failed",
  );

  // MCP 9100 is not the workload. Hands dying inside a running container is
  // what the recovery path restarts in place, and tearing the pod down here
  // takes the user's training run with it -- the same holder-kill the in-flight
  // rebuild already refuses to perform. So only a data plane that says the
  // sandbox is gone licenses the destroy below. A token is required for the
  // container to be worth keeping: without one nothing can talk to Hands once
  // it is back.
  if (!health.ok && hasToken) {
    const recovered = await recoverUnhealthyReuse(
      kv,
      sessionId,
      info,
      identity,
      entry.revision,
      signal,
    );
    if (recovered) return recovered;
  }

  // Reap the referenced workload (stop in SaFE + delete KV) before recreating.
  // destroyHands reads workloadId + platformKey from the KV entry we just
  // observed; if either is missing it will just delete KV.
  await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
  return null;
}

/**
 * Clear the idle markers on the entry that passed the gate, if it has any.
 *
 * Conditional on a revision so a concurrent sibling wins rather than being
 * overwritten with this stale snapshot -- but a lost CAS is not a lost sandbox,
 * and treating it as one is worse than the overwrite it prevents. Three writers
 * bump this key without changing who owns it: the run-lease heartbeat and the
 * keepalive ticker both re-put it to refresh its TTL, and a sibling may be
 * clearing the same markers. The read this revision came from is separated from
 * here by a health check, and on the recovery path by a probe and a full Hands
 * restart as well -- tens of seconds, against a heartbeat that fires every ten.
 * So the conflict is the common case, not the rare one, and failing the turn on
 * it threw away repairs that had already succeeded.
 *
 * Re-read instead, and only refuse when the key has come to name a *different*
 * sandbox. Ownership is the thing worth protecting; the TTL bump is not.
 */
async function clearIdleMarkers(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  identity: SandboxEntry,
  revision: number,
): Promise<void> {
  if (info.keepalive === undefined && info.idleSince == null) return;
  // Same reason the retry below skips these: `keepalive:false` is what marks a
  // handle parked, and eligibleForClusterReclaim refuses any entry whose
  // keepalive is not false, so clearing it here would strip a session delete's
  // parking and strand its GPU clusters. The retry was guarded and this, the
  // path that runs when the entry is already parked at first read, was not.
  if (info.sessionDeleted === true) {
    logger.warn({ sessionId }, "ensureHands.idle_markers_left_parked");
    return;
  }
  delete info.keepalive;
  delete info.idleSince;
  const key = `hands.${sessionId}`;
  const payload = sc.encode(JSON.stringify(info));
  try {
    await kv.update(key, payload, revision);
    return;
  } catch (err) {
    // Only a lost race falls through to the re-read. A bucket that is actually
    // unavailable is not a race, and retrying it here would just fail twice --
    // the markers stay, and the sandbox is still reusable.
    if (!isRevisionConflict(err)) {
      logger.warn({ err: String(err), sessionId }, "ensureHands.idle_markers_not_cleared");
      return;
    }
  }
  try {
    const latest = await kv.get(key);
    if (!latest) return;
    // The markers are not part of the identity HandsProbeEntry describes, but
    // they live on the same value and this is the writer that removes them.
    const current = parseHandsProbeValue(sc.decode(latest.value)) as HandsProbeEntry
      & { keepalive?: boolean; idleSince?: unknown; sessionDeleted?: boolean };
    // Parked by a session delete while we were losing the race. Same sandbox,
    // so the identity check below would pass -- but clearing `keepalive:false`
    // here un-parks it, and eligibleForClusterReclaim refuses any entry whose
    // keepalive is not false, so the session's GPU clusters would never be
    // reclaimed. The single-shot CAS this retry replaced simply lost and left
    // it alone; the retry has to do the same deliberately.
    if (current.sessionDeleted === true) {
      logger.warn({ sessionId }, "ensureHands.idle_markers_left_parked");
      return;
    }
    if (!sameHandsSandbox(identity, current)) {
      // Someone else's sandbox now. Reusing ours is still correct -- it passed
      // its own health check under its own identity -- but its markers are not
      // ours to clear.
      logger.warn({ sessionId }, "ensureHands.idle_markers_owner_changed");
      return;
    }
    if (current.keepalive === undefined && current.idleSince == null) return;
    await kv.update(key, sc.encode(JSON.stringify({
      ...current, keepalive: undefined, idleSince: undefined,
    })), latest.revision);
  } catch (err) {
    // Left parked at worst: the ticker will not ping it, and the next request
    // reactivates it. Not a reason to refuse a sandbox that answered.
    logger.warn(
      { err: String(err), sessionId },
      "ensureHands.idle_markers_not_cleared",
    );
  }
}

/** Keepalive and idle-marker bookkeeping shared by both paths that reuse. */
async function acceptExistingSandbox(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  identity: SandboxEntry,
  revision: number,
): Promise<EnsureHandsResult> {
  // Reactivate a post-task idle reuse handle: clear the keepalive:false marker
  // so the ticker resumes owning it as an active session and
  // stopKeepaliveAfterTask re-marks it idle when this task ends. A handle with
  // no markers needs no write at all -- the entry that passed the gate is
  // already the entry we want.
  await clearIdleMarkers(kv, sessionId, info, identity, revision);
  reuseEffects.registerSandbox(sessionId, identity);
  return { handsUrl: info.handsUrl, created: false, token: info.token, identity };
}

async function provisionHands(
  sessionId: string,
  request: ExecuteRequest,
  platformKey: string,
  onEvent: (evt: Record<string, unknown>) => Promise<void>,
  multiNodeContext?: MultiNodeContext,
  options: EnsureHandsOptions = {},
): Promise<EnsureHandsResult> {
  const kv = getHandsKv();

  // Local dev mode: Hands is running locally — treat as "not created" (no
  // lifecycle, no need to restore workspace from S3).
  //
  // Skip this short-circuit when the caller carries a real sandbox_spec
  // (mode=script + sandbox.{handle,use,image} from the Task DAG path) --
  // otherwise local Hands would silently service requests that explicitly
  // asked for a fresh / reused SaFE workload. Chat-mode requests that have
  // no sandbox_spec at all still go through the local-dev shortcut.
  //
  // Ahead of the reuse check now, because the reuse check needs the parsed
  // request and parsing throws for the imageless chat requests that are the
  // whole point of local-dev mode.
  const callerWantsRealSandbox = !!request.sandbox_spec
    && request.sandbox_spec !== "none";
  if (HANDS_MCP_URL && !callerWantsRealSandbox) {
    if (!AUTH_INTERNAL_TOKEN) {
      logger.error({ sessionId }, "auth_failed_missing_internal_token");
      throw new Error("auth_failed_missing_internal_token");
    }
    logger.info({ sessionId, handsUrl: HANDS_MCP_URL }, "ensureHands.local_dev_mode");
    return { handsUrl: HANDS_MCP_URL, created: false, token: AUTH_INTERNAL_TOKEN };
  }

  // Phase 0.3: sandbox parameters come from a normalized `SandboxSpec`. We
  // accept both the new `request.sandbox_spec` form (Phase 4+ task-system
  // path) and the legacy top-level `sandbox_image`/`resources`/`timeout`
  // chat fields via the resolver.
  //
  // Resolved before anything is reused, not after: the reuse check cannot judge
  // whether a live sandbox serves this request until it knows what the request
  // asked for. It also puts `use` ahead of the session lookup, which matters
  // because every node of a DAG shares one session_id -- a `use` node used to
  // hit `hands.<sessionId>` first and get back whichever sandbox last wrote
  // that key, never consulting the handle it named.
  let action;
  try {
    action = resolveSandboxAction(request);
  } catch (resolveErr) {
    // Fallback to the legacy prompt-scan heuristic only for chat-mode
    // requests that lack both `sandbox_spec` and `sandbox_image`.
    const fromPrompt = resolveSandboxImageFromRequest(request);
    if (!fromPrompt) throw resolveErr;
    action = {
      kind: "create" as const,
      handle: "main",
      params: {
        image: fromPrompt,
        resources: {},
        timeout: undefined as number | undefined,
        env: {} as Record<string, string>,
        labels: {} as Record<string, string>,
      },
    };
  }
  if (action.kind === "none") {
    throw new Error("ensureHands called for sandbox_spec='none'; caller must short-circuit");
  }
  if (action.kind === "use") {
    // task-design.md §9.4: look the handle up in DagHandleMap; an upstream
    // node should have registered it via sandbox.create. Surface a clear
    // error when the handle is missing so the DAG fails fast instead of
    // silently spawning a fresh sandbox.
    const dagRoot = request.dag_root_task_id ?? request.task_id;
    if (!dagRoot) {
      throw new Error("sandbox_spec.use requires dag_root_task_id on the request");
    }
    const info = await lookupDagHandle(dagRoot, action.handle);
    if (!info || !info.hands_url || !info.token) {
      throw new Error(
        `sandbox_spec.use='${action.handle}' has no registered handle for dag ${dagRoot}`,
      );
    }
    const identity: SandboxEntry = info.provider === "agent-sandbox"
      ? {
        provider: "agent-sandbox",
        sessionId: info.session_id,
        sandboxName: info.sandbox_name,
        namespace: info.namespace,
        userId: info.user_id,
      }
      : {
        workloadId: info.workload_id,
        platformKey: info.platform_key ?? "",
        // The namespace the upstream node recorded, not the deployment default:
        // a workspace-scoped sandbox lives in the namespace its request named,
        // and keepalive addressed to the default would poll a workload that is
        // not there and let a live sandbox expire. The default is only the
        // fallback for entries written before the field existed.
        namespace: info.namespace || SANDBOX_NAMESPACE,
      };
    // A registered handle is not necessarily a living Hands endpoint. Probe
    // and restart against this handle's identity, never the shared session key.
    await assertDagHandleAlive(
      action.handle,
      dagRoot,
      sessionId,
      info.hands_url,
      identity,
      info.token,
      options.signal,
    );
    logger.info(
      { sessionId, dagRoot, handle: action.handle, provider: info.provider ?? "safe-workload", workloadId: info.workload_id, handsUrl: info.hands_url },
      "ensureHands.reusing_dag_handle",
    );
    reuseEffects.registerSandbox(sessionId, identity);
    return { handsUrl: info.hands_url, created: false, token: info.token, identity };
  }

  // What the caller is asking for, condensed so it can be compared against what
  // the session's existing sandbox was actually built with.
  const requestedSpec = requestSpecFingerprint(request, action);

  if (!options.skipSessionReuse) {
    const reused = await tryReuseSessionSandbox({
      kv, sessionId, request, multiNodeContext, requestedSpec, onEvent,
      signal: options.signal,
    });
    if (reused) return reused;
  }

  // kubernetes/BYOK: the selected LLM key is injected into the sandbox; safe
  // mode keeps using the SaFE platformKey for sandbox auth/control-plane.
  const apiKey = isKubernetesMode() ? resolveRequestLlmKey(request) : platformKey;
  if (isKubernetesMode()) {
    if (!apiKey) throw new Error("ensureHands: selected LLM key is required in kubernetes mode");
  } else if (!platformKey) {
    throw new Error("ensureHands: platformKey is required");
  }

  logger.info({
    sessionId,
    spec_kind: action.kind,
    handle: action.handle,
    image: action.params.image,
    resources: action.params.resources,
    plugin_id: request.plugin_id ?? "(undefined)",
  }, "DEBUG.ensureHands.payload_check");

  const workloadImage = assertImageDigest(request.sandbox_spec, action.params.image);
  if (!workloadImage) {
    throw new Error("Missing image in resolved sandbox params.");
  }
  // SaFE workload create accepts the array form ({key,value}[]); keep that
  // contract while letting EffectiveSandboxParams stay in the map shape.
  // Legacy chat resources (still object-form on the request body) flow
  // through resolveSandboxAction → map → array unchanged.
  const workloadResourcesArr = effectiveWorkloadResources(request, action.params);
  if (!workloadResourcesArr?.length) {
    throw new Error(
      "workload resources are missing or invalid (need cpu/memory/gpu/ephemeral-storage). " +
        "They resolve from the request, then the plugin row, then the resources table's " +
        "type='default' row -- seed that row (chart value defaultSandbox) if this is a " +
        "fresh deployment.",
    );
  }

  // Per-sandbox bearer token. Blast radius on leak is limited to this one session.
  const handsToken = randomBytes(32).toString("hex");
  registerHandsToken(sessionId, handsToken);

  const mcpPort = "9100";
  // Base envs (must always be present). User-supplied env from sandbox_spec
  // is merged on top so callers can add e.g. ROCm version pins or app config,
  // but cannot overwrite the auth/MCP plumbing that Brain relies on.
  let env: Record<string, string> = {
    ...(action.params.env ?? {}),
    AUTH_CLAW_TOKEN: handsToken,
    CLAW_SESSION_ID: sessionId,
    HYPERLOOM_SESSION_ID: sessionId,
    INFERENCE_OPTIMIZER_SESSION_LAYOUT: "per_model_ts",
    MCP_PORT: mcpPort,
    WORKSPACE_PATH: "/workspace",
    SAFE_API_URL: SAFE_API_URL,
  };
  // LLM gateway URL is NOT injected here — agent CLIs receive it via the
  // sandbox image's agent_setup.sh / user-env (per-user override) so this
  // path stays gateway-agnostic. Brain only forwards the SaFE platform key
  // (apiKey) under the conventional Anthropic/OpenAI env names so any agent
  // CLI can authenticate against whichever endpoint setup.sh pinned. apiKey
  // is the caller's per-user `ak-...` SaFE platform key, which means cost
  // tracking + auditing stays per-user at the SaFE layer instead of through
  // a shared virtualKey relay.
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  // Multi-node: point Hyperloom's SaFE-less external mode at the cluster Brain
  // already provisioned instead of the per-user SaFE workload it would
  // otherwise try to create itself (see multi_node/SKILL.md "External mode").
  if (multiNodeContext) {
    applyMultiNodeExternalEnv(env, multiNodeContext);
  }

  // Compose admin-managed system_env and user/session env onto the base env.
  // user_env wins over base/system for allowed keys; CLAW internal / SaFE keys
  // in `base` are protected by the deny lists.
  env = composeSandboxEnv({
    base: env,
    systemEnv: getSystemEnv(),
    userEnv: request.user_env ?? {},
    sessionEnv: request.session_env ?? {},
  });

  // ── kubernetes/BYOK mode: agent-sandbox provider path (design §16.5). ──
  // safe mode falls through to the SaFE Workload path below (unchanged).
  if (isKubernetesMode()) {
    if (action.kind !== "create") {
      throw new Error("agent-sandbox requires a create action");
    }
    return await ensureHandsAgentSandbox(
      sessionId, request, action, workloadImage, env, handsToken, mcpPort, onEvent,
      requestedSpec,
    );
  }

  const nsForSandbox = sandboxNamespaceFor(request);
  // Sweeper relies on `dag-root` + `sandbox-handle` to reconcile orphan
  // workloads against the DagHandleMap KV (see task-design.md §9.4 sweeper).
  const labels: Record<string, string> = {
    "primus-claw/session-id": sessionId,
    "primus-claw/component": "hands",
    "primus-claw/plugin-id": request.plugin_id != null ? String(request.plugin_id) : "",
    "primus-claw/dag-root": request.dag_root_task_id ?? request.task_id ?? "",
    "primus-claw/dag-node": request.dag_node_id ?? "single",
    "primus-claw/sandbox-handle": action.handle,
    "team": "primus-claw",
    ...(action.params.labels ?? {}),
  };
  const ttlSeconds = action.params.ttl_sec ?? DEFAULT_SANDBOX_TTL_SEC;
  // Business timeout = the sandbox's max RUNNING lifetime (seconds). It is
  // forwarded to SaFE, whose timeout is counted from Status.StartTime (written
  // when the workload leaves Pending and starts running, not at dispatch), so it
  // does NOT include the Pending/queue wait — that is bounded separately by
  // SANDBOX_PENDING_TIMEOUT_SECONDS in the poll loop. SafeWorkloadProvider adds
  // the +3600s graceful-shutdown buffer on top. When undefined, the configured
  // default is the total lifetime and already includes any shutdown allowance.
  const timeoutSec = action.params.timeout ?? normalizeWorkloadTimeout(request.timeout);
  const sandboxImage = workloadImage || null;

  // Two-phase KV bookkeeping (A): record a "pending" entry the moment SaFE
  // assigns a workloadId (provider onProvisioned hook), before poll / bootstrap
  // / health. Rollback (stop) if the KV write fails so we never leak a workload.
  // Owned here so SafeWorkloadProvider stays KV-free.
  const onProvisioned = async (workloadId: string): Promise<void> => {
    const pendingPayload = sc.encode(JSON.stringify({
      status: "pending", workloadId, sandboxImage,
      platformKey: apiKey, token: handsToken, namespace: nsForSandbox,
      createdAt: new Date().toISOString(),
    }));
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await kv.put(`hands.${sessionId}`, pendingPayload); ok = true; break; }
      catch (kvErr) {
        logger.warn({ err: (kvErr as Error)?.message || String(kvErr), sessionId, workloadId, attempt }, "hands.kv.pending_put_retry");
        if (attempt < 3) await sleep(200);
      }
    }
    if (!ok) {
      logger.error({ sessionId, workloadId }, "hands.kv.pending_put_failed_rollback");
      await getSafeWorkloadProvider().stop({
        provider: "safe-workload", id: workloadId, sandboxName: workloadId,
        namespace: nsForSandbox, handsBaseUrl: "", platformKey: apiKey,
      }).catch(() => {});
      throw new Error(`KV pending write failed for workload ${workloadId}, rolled back`);
    }
    logger.info({ sessionId, workloadId }, "hands.kv.pending");
  };

  logger.info({ sessionId, sandboxImage, namespace: nsForSandbox }, "ensureHands.creating_workload");

  const inst = await getSafeWorkloadProvider().create({
    sessionId,
    namespace: nsForSandbox,
    image: workloadImage,
    resources: action.params.resources,
    resourcesArray: workloadResourcesArr,
    env,
    labels,
    timeoutSec,
    ttlSec: ttlSeconds,
    platformKey: apiKey,
    onProvisioned,
    onEvent,
  });
  const workloadId = inst.id;
  const handsBaseUrl = `http://${workloadId}.${nsForSandbox}.svc.cluster.local:${mcpPort}`;

  logger.info({ sessionId, workloadId, handsBaseUrl }, "ensureHands.bootstrap_start");
  await bootstrapHandsInSandbox(
    (cmd, t) => getSafeWorkloadProvider().exec(inst, cmd, t),
    sessionId, mcpPort, handsToken, env,
  );
  logger.info({ sessionId, workloadId }, "ensureHands.bootstrap_done");

  // Wait for /health (fail hard if Hands never comes up)
  logger.info({ sessionId, workloadId }, "ensureHands.health_check_start");
  let handsHealthy = false;
  for (let i = 0; i < HANDS_HEALTH_MAX_TRIES; i++) {
    try {
      const hr = await fetch(`${handsBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (hr.ok) { handsHealthy = true; break; }
    } catch { /* retry */ }
    await sleep(HANDS_HEALTH_INTERVAL_MS);
  }
  if (!handsHealthy) {
    const waitSec = Math.round((HANDS_HEALTH_MAX_TRIES * HANDS_HEALTH_INTERVAL_MS) / 1000);
    // Pull hands.log tail to surface the real startup error.
    let logTail = "<unavailable>";
    try {
      const tail = await getSafeWorkloadProvider().exec(inst, "tail -c 2000 /workspace/hands.log 2>&1 || true", "15s");
      logTail = (tail.stdout || tail.stderr || "<empty>").slice(-1800);
    } catch { /* ignore */ }
    logger.error({ sessionId, workloadId, handsLog: logTail }, "hands.health_failed");
    throw new Error(
      `Hands health check failed after ${waitSec}s: ${handsBaseUrl}/health (workload=${workloadId}); hands.log tail: ${logTail.slice(0, 500)}`,
    );
  }

  const handsUrl = `${handsBaseUrl}/mcp`;
  logger.info({ sessionId, workloadId, handsUrl }, "ensureHands.health_ok");

  // infera drives its GPU pods over SSH, so the key Brain derived for this
  // cluster has to exist as a file here before the optimizer runs.
  if (multiNodeContext?.sshPrivateKey && multiNodeContext.sshKeyPath) {
    await writeSandboxSshKey(
      (cmd, t) => getSafeWorkloadProvider().exec(inst, cmd, t),
      multiNodeContext.sshKeyPath,
      multiNodeContext.sshPrivateKey,
    );
    logger.info({ sessionId, workloadId, keyPath: multiNodeContext.sshKeyPath }, "ensureHands.mn_ssh_key_written");
  }

  // Store in NATS KV (shared across Brain instances).
  // Phase two of two-phase bookkeeping (A): promote PENDING -> READY once
  // bootstrap + health have both passed. Only READY entries are reusable on
  // re-attach (see ensureHands read path). `templateId` is needed by the
  // sandbox-keepalive ticker so it can call the SaFE data-plane execute
  // endpoint without re-resolving the template. `platformKey` is the
  // per-session credential used by keepalive and by destroyHands. There is
  // no admin fallback any more, so this field is mandatory — without it the
  // next SaFE call will fail. The bucket is cluster-internal and the entry
  // rotates with the 5-minute KV TTL.
  const kvKey = `hands.${sessionId}`;
  const readyPayload = sc.encode(JSON.stringify({
    status: "ready",
    // The key the run lease is actually under. Not the session: the gate is
    // workspace-scoped by default, so a run holding files takes
    // `lock.ws.<workspaceId>`, and only an unbound run falls back to the DAG
    // root or the session. A sweeper cannot derive any of that from the entry.
    runScope: pickLockKey(request),
    workloadId,
    handsUrl,
    sandboxImage: workloadImage || null,
    // What this sandbox was built to, so the next request can tell whether it
    // is still being asked for the same thing. Entries written before this
    // field existed are treated as matching -- see evaluateReuse.
    specFingerprint: requestedSpec,
    platformKey: apiKey || "",
    // Per-sandbox bearer token. The sandbox's hands process reads it from its
    // own AUTH_INTERNAL_TOKEN env; Brain reads it back here on re-attach.
    token: handsToken,
    // Sandbox namespace (== SaFE workspaceId) this workload lives in. The
    // keepalive ticker needs it to build the SaFE data-plane exec URL, since
    // that background loop has no per-request context of its own.
    namespace: nsForSandbox,
    // Multi-node cluster URL baked into env at create (observability only).
    mnServiceUrl: multiNodeContext?.serviceUrl ?? null,
    createdAt: new Date().toISOString(),
  }));

  const KV_READY_MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= KV_READY_MAX_RETRIES; attempt++) {
    await kv.put(kvKey, readyPayload);
    // Read-back verification: confirm the entry is visible to other consumers
    // (e.g. sandbox-keepalive). NATS KV is strongly consistent within a single
    // server, but the read-back catches silent put failures and encoding issues.
    const verify = await kv.get(kvKey).catch(() => null);
    if (verify) {
      try {
        const parsed = JSON.parse(sc.decode(verify.value));
        if (parsed.workloadId === workloadId && parsed.status === "ready") break;
        logger.warn({ sessionId, workloadId, attempt, parsedWl: parsed.workloadId, parsedStatus: parsed.status }, "hands.kv.ready_verify_mismatch");
      } catch {
        logger.warn({ sessionId, workloadId, attempt }, "hands.kv.ready_verify_parse_failed");
      }
    } else {
      logger.warn({ sessionId, workloadId, attempt }, "hands.kv.ready_verify_missing");
    }
    if (attempt === KV_READY_MAX_RETRIES) {
      logger.error({ sessionId, workloadId }, "hands.kv.ready_verify_exhausted");
    }
    await sleep(200);
  }
  logger.info({ sessionId, workloadId, handsUrl }, "hands.created");

  const identity: SandboxEntry = {
    workloadId,
    platformKey: apiKey || "",
    namespace: nsForSandbox,
  };
  reuseEffects.registerSandbox(sessionId, identity);

  // task-design.md §9.4: when the calling task belongs to a DAG and declared
  // a sandbox.handle name, publish a HandleInfo to the DagHandleMap so any
  // downstream node with `sandbox.use=<handle>` can short-circuit ensureHands
  // and connect directly to this workload. Failures are non-fatal -- the DAG
  // can still complete with sandbox-per-node semantics, just without reuse.
  const dagRoot = request.dag_root_task_id ?? request.task_id;
  if (dagRoot && action.kind === "create" && action.handle) {
    try {
      await registerDagHandle(dagRoot, action.handle, {
        workload_id: workloadId,
        hands_url: handsUrl,
        token: handsToken,
        platform_key: apiKey || "",
        image: workloadImage,
        // Keepalive polls this namespace. The use-path falls back to the
        // deployment default when the field is missing, so a workspace-scoped
        // sandbox would be polled where it is not and expire while still live.
        namespace: nsForSandbox,
      });
    } catch (e) {
      logger.warn(
        { sessionId, dagRoot, handle: action.handle, err: (e as Error).message },
        "ensureHands.handle_register_failed",
      );
    }
  }

  return { handsUrl, created: true, token: handsToken, identity };
}


/**
 * `provisionHands` plus the sandbox-creation counters.
 *
 * The measurement sits here rather than around the two `created: true` returns
 * inside because those are in different functions on different providers, and a
 * counter that only one of them reaches is worse than none: the gap looks like
 * "no sandboxes were created", not "this path is not instrumented".
 *
 * Only a call that actually built a sandbox is counted. Reuse and the local-dev
 * short-circuit both return `created: false` and are not creation attempts, so
 * counting them would put the reuse rate into a latency histogram whose help
 * text promises creation time.
 *
 * A throw is counted as a failed attempt even when it came from the reuse probe
 * that runs first, because by then the caller has no sandbox either way, and
 * the alternative -- reporting only the failures that happen after the decision
 * to create -- hides exactly the provisioning outages this is meant to show.
 *
 * An aborted call is the exception. A run cancelled out from under this one --
 * a lease lost to another replica, a user interrupt, SIGTERM -- cancels the
 * probe and surfaces as a throw, and nothing refused to build anything: the
 * caller stopped wanting a sandbox. Counting it would put a spike on this
 * counter during every rolling update, which is exactly when lease handovers
 * and redeliveries are densest, and the panel would report a provisioning
 * outage caused by the deploy that was in fact the deploy working.
 */
export async function ensureHands(
  sessionId: string,
  request: ExecuteRequest,
  platformKey: string,
  onEvent: (evt: Record<string, unknown>) => Promise<void>,
  multiNodeContext?: MultiNodeContext,
  options: EnsureHandsOptions = {},
): Promise<EnsureHandsResult> {
  const startedAt = Date.now();
  try {
    const result = await provisionHands(
      sessionId, request, platformKey, onEvent, multiNodeContext, options,
    );
    if (result.created) {
      metrics.onSandboxStart("ok", (Date.now() - startedAt) / 1000);
    }
    return result;
  } catch (err) {
    if (!options.signal?.aborted) {
      metrics.onSandboxStart("error", (Date.now() - startedAt) / 1000);
    }
    throw err;
  }
}

function toHex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("hex");
}

/** [security] BYOK user identity, matching the API auth fingerprint (byok-<fp>).
 *  Forwarded to the Router as the `userId` header for ownership + audit (#5). */
async function deriveByokUserId(apiKey: string): Promise<string> {
  if (!AUTH_INTERNAL_TOKEN) {
    throw new Error("AUTH_INTERNAL_TOKEN is required to derive BYOK user id");
  }
  // Not password storage/verification: this is a keyed tenant fingerprint for BYOK isolation.
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    "raw",
    enc.encode(AUTH_INTERNAL_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return "byok-" + toHex(await webcrypto.subtle.sign("HMAC", key, enc.encode(apiKey))).slice(0, 16);
}

/**
 * kubernetes/BYOK path: provision Hands via the agent-sandbox provider, then
 * bootstrap hands-binary, health-check, single-phase KV, register keepalive.
 * env already carries AUTH_CLAW_TOKEN / MCP_PORT / WORKSPACE_PATH and the BYOK
 * key under ANTHROPIC_API_KEY / OPENAI_API_KEY. See design §16.5.
 */
async function ensureHandsAgentSandbox(
  sessionId: string,
  request: ExecuteRequest,
  action: Extract<SandboxAction, { kind: "create" }>,
  workloadImage: string,
  env: Record<string, string>,
  handsToken: string,
  mcpPort: string,
  onEvent: (evt: Record<string, unknown>) => Promise<void>,
  /**
   * Passed in rather than recomputed, because the value stored here is what a
   * later request compares itself against: two call sites deriving it
   * separately would only have to drift once for every reuse check on the
   * kubernetes path to miss and rebuild.
   */
  requestedSpec: string,
): Promise<EnsureHandsResult> {
  const kv = getHandsKv();
  const provider = getAgentSandboxProvider();
  const ns = sandboxNamespaceFor(request);
  // BYOK identity forwarded to the Router as `userId` header for ownership/audit (#5).
  const userId = await deriveByokUserId(resolveRequestLlmKey(request));

  // BYOK env: no SaFE credentials reach this path; inject platform LLM base url
  // (DK2-A). Only the URL needs deleting -- the base env carries no SaFE key, and
  // protocol's deny list stops a caller supplying one. Anything SaFE-ish added to
  // the base env later has to be dropped here too.
  delete env.SAFE_API_URL;
  if (ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL;
  if (OPENAI_BASE_URL) env.OPENAI_BASE_URL = OPENAI_BASE_URL;

  const labels: Record<string, string> = {
    "primus-claw/session-id": sessionId,
    "primus-claw/component": "hands",
    "team": "primus-claw",
    ...(action.params.labels ?? {}),
  };

  await onEvent({ type: "sandboxStatus", event: "phase", phase: "Creating", status: "creating", log: "" });
  const inst = await provider.create({
    sessionId,
    namespace: ns,
    image: workloadImage,
    resources: action.params.resources,
    env,
    labels,
    timeoutSec: action.params.timeout,
    userId,
  });
  try {
    await onEvent({ type: "sandboxStatus", event: "phase", phase: "Running", status: "running" });

    logger.info(
      { sessionId, sandboxName: inst.sandboxName, handsBaseUrl: inst.handsBaseUrl },
      "ensureHands.agent.bootstrap_start",
    );
    await bootstrapHandsInSandbox(
      (cmd, t) => provider.exec(inst, cmd, t),
      sessionId, mcpPort, handsToken, env,
    );

    // Health check on Hands MCP (podIP:9100).
    let handsHealthy = false;
    for (let i = 0; i < HANDS_HEALTH_MAX_TRIES; i++) {
      try {
        const hr = await fetch(`${inst.handsBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (hr.ok) { handsHealthy = true; break; }
      } catch { /* retry */ }
      await sleep(HANDS_HEALTH_INTERVAL_MS);
    }
    if (!handsHealthy) {
      let logTail = "<unavailable>";
      try {
        const tail = await provider.exec(inst, "tail -c 2000 /workspace/hands.log 2>&1 || true", "15s");
        logTail = (tail.stdout || tail.stderr || "<empty>").slice(-1800);
      } catch { /* ignore */ }
      logger.error({ sessionId, sandboxName: inst.sandboxName, handsLog: logTail }, "hands.health_failed");
      throw new Error(
        `Hands health check failed: ${inst.handsBaseUrl}/health; hands.log tail: ${logTail.slice(0, 500)}`,
      );
    }

    const handsUrl = `${inst.handsBaseUrl}/mcp`;

    // Single-phase KV: create already blocked until pod healthy (no pending window).
    // If this write fails, roll back below; without KV, destroyHands cannot stop
    // the agent-sandbox session later.
    await kv.put(`hands.${sessionId}`, sc.encode(JSON.stringify({
      status: "ready",
      // The key the run lease is actually under -- see the note on the other
      // create path: workspace-gated by default, session only as a fallback.
      runScope: pickLockKey(request),
      provider: "agent-sandbox",
      sessionId: inst.id,
      sandboxName: inst.sandboxName,
      workloadId: "",
      handsUrl,
      sandboxImage: workloadImage,
      specFingerprint: requestedSpec,
      platformKey: "",
      token: handsToken,
      namespace: inst.namespace,
      userId,
      createdAt: new Date().toISOString(),
    })));

    const identity: SandboxEntry = {
      provider: "agent-sandbox",
      sessionId: inst.id,
      sandboxName: inst.sandboxName,
      namespace: inst.namespace,
      userId,
    };
    reuseEffects.registerSandbox(sessionId, identity);

    // task-design.md §9.4: publish the handle so downstream DAG nodes with
    // `sandbox.use=<handle>` can re-attach. agent-sandbox has no workload_id,
    // so carry the provider + agent-sandbox identity for the use path. Failures
    // are non-fatal -- the DAG falls back to sandbox-per-node semantics.
    const dagRoot = request.dag_root_task_id ?? request.task_id;
    if (dagRoot && action.handle) {
      try {
        await registerDagHandle(dagRoot, action.handle, {
          workload_id: "",
          provider: "agent-sandbox",
          session_id: inst.id,
          sandbox_name: inst.sandboxName,
          namespace: inst.namespace,
          user_id: userId,
          hands_url: handsUrl,
          token: handsToken,
          image: workloadImage,
        });
      } catch (e) {
        logger.warn(
          { sessionId, dagRoot, handle: action.handle, err: (e as Error).message },
          "ensureHands.agent.handle_register_failed",
        );
      }
    }

    logger.info({ sessionId, sandboxName: inst.sandboxName, handsUrl }, "ensureHands.agent.ready");
    return { handsUrl, created: true, token: handsToken, identity };
  } catch (err) {
    logger.warn(
      { err: String(err), sessionId, agentSessionId: inst.id, sandboxName: inst.sandboxName },
      "ensureHands.agent_rollback",
    );
    await provider.stop(inst).catch((stopErr) =>
      logger.warn({ err: String(stopErr), sessionId, agentSessionId: inst.id }, "ensureHands.agent_rollback_stop_failed"),
    );
    throw err;
  }
}
