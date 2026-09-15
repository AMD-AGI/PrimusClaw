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
import { StringCodec, type KV } from "nats";
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
import type { HandsHealthResult } from "./hands-health.js";
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
import { dagHoldsWorkload, handleIdentityKey, lookupDagHandle, releaseHandlesForWorkload, replaceDagHandle, workloadHeldByOtherDag } from "./handles.js";
import { getHandsKv, registerHandsToken } from "./registry.js";
import { bootstrapHandsInSandbox, HANDS_LOG_PATH, HANDS_STATE_DIR } from "./bootstrap.js";
import { countLiveWork, type LiveWorkAnswer } from "./live-work-gate.js";
import { retainContainer } from "./retain-container.js";
import { restartHandsInSandbox } from "./hands-restart.js";
import { markHandsIdle, registerSandbox, unregisterSandbox } from "./keepalive.js";
import type { SandboxEntry } from "./keepalive.js";
import {
  instanceFromEntry,
  parseHandsProbeValue,
  probeSandboxContainer,
  sameHandsSandbox,
  type ContainerProbeOutcome,
  type HandsProbeEntry,
} from "./container-probe.js";
import { sandboxSpecFingerprint, evaluateReuse } from "./spec-fingerprint.js";
import { metrics } from "../infra/metrics.js";
import { handsSessionKey } from "./hands-key.js";
import { readHandsEntry, retentionStore, type HandsBinding } from "./registry.js";
import { RETENTION_LEDGER_FILTER } from "./retain-container.js";
import {
  admitSandbox, assertFleetCensused, type AdmissionHold,
} from "./admission.js";
import { pingTargetIdentity } from "./keepalive.js";

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
 * the workload API, and `registerSandbox` adds to the registry the keepalive
 * ticker walks. Neither is
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
  // The two halves of undoing an adoption. Through the seam for the same
  // reason the rest of it is: the undo runs only when a registration failed,
  // which no test can reach through a real KV, and it is the piece that has
  // already been wrong once -- it addressed the Router's session id rather
  // than Claw's, so it unwound nothing and reported success.
  unregisterSandbox: typeof unregisterSandbox;
  markHandsIdle: typeof markHandsIdle;
  dagHoldsWorkload: typeof dagHoldsWorkload;
  workloadHeldByOtherDag: typeof workloadHeldByOtherDag;
  releaseHandlesForWorkload: typeof releaseHandlesForWorkload;
  countLiveWork: typeof countLiveWork;
  retainContainer: typeof retainContainer;
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
  dagHoldsWorkload,
  workloadHeldByOtherDag,
  releaseHandlesForWorkload,
  destroyHands, registerSandbox, probeSandboxContainer, restartHandsInSandbox,
  unregisterSandbox, markHandsIdle,
  countLiveWork, retainContainer,
};
let reuseEffects: SandboxReuseEffects = realReuseEffects;

/** Override the effects above; returns the call that puts them back. */
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

async function recoverOrRetainUnusableSandbox(
  attempt: ReuseAttempt,
  info: any,
  identity: SandboxEntry,
  binding: HandsBinding,
  health: HandsHealthResult,
  hasToken: boolean,
): Promise<EnsureHandsResult | null> {
  const { kv, sessionId, signal } = attempt;
  logger.warn(
    { sessionId, health: health.detail, hasToken },
    health.ok ? "ensureHands.health_ok_but_unusable" : "ensureHands.health_check_failed",
  );

  // MCP liveness does not determine whether the container and its work may be destroyed.
  if (!health.ok && hasToken) {
    const recovered = await recoverUnhealthyReuse(
      kv,
      sessionId,
      info,
      identity,
      binding,
      signal,
    );
    if (recovered) return recovered;
  }

  // Two separate questions, and destroying needs both answered. `mayDestroy`
  // asks whether the container has live work in it; this asks whether the
  // sandbox is even this DAG's to recreate. Unhealthy to US, over an entry a
  // session shares between concurrent DAGs, is not a licence over somebody
  // else's workload -- and a sibling's sandbox can be perfectly healthy while
  // our probe of it fails.
  if (await entryOwnedByAnother(info, attempt.request)) {
    logger.warn(
      { sessionId, workloadId: info.workloadId, entryDagRoot: info.dagRootTaskId ?? null },
      "hands.kv.unhealthy_rebuild_skipped_other_owner",
    );
    return null;
  }
  const live = await mayDestroy(sessionId, identity, signal);
  if (live.verdict === "clear") {
    await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    return null;
  }
  await retainInsteadOfDestroying(kv, sessionId, info, live, binding);
  return null;
}

async function recoverUnhealthyReuse(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  identity: SandboxEntry,
  binding: HandsBinding,
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
    // pod's environment cannot be reproduced -- so every later turn on this
    // session would fail the same way. The session's claim is released so the
    // caller gets a working sandbox by the ordinary path; the container itself
    // is not the caller's to destroy, and what decides its fate is what is
    // still running in it.
    if (restarted.refused) {
      logger.warn(
        { sessionId, handsUrl: info.handsUrl, detail: restarted.detail },
        "ensureHands.restart_refused",
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
  return acceptExistingSandbox(kv, sessionId, info, identity, binding);
}

/**
 * Release this session's claim on a container that still holds live work.
 *
 * Not a destroy and not a refusal: the caller goes on to the ordinary
 * acquisition path and is handed a freshly provisioned sandbox, exactly as a
 * rebuild would have handed it one. Nothing it can observe varies with what was
 * found here -- the count decides which container it gets, never what it is
 * told -- so the finding reaches operator telemetry alone.
 */
/**
 * A workload that has been retained no longer owns the handle naming it.
 *
 * Read from the retention ledger, which is what `retainContainer` writes first
 * and what a lost projection is restored from -- so it is the durable answer to
 * "was this container handed over", and the one thing a failed handle release
 * cannot invalidate.
 */
function retainedTaker(kv: ReuseAttempt["kv"]): (previousWorkloadId: string) => Promise<boolean> {
  return async (previousWorkloadId: string): Promise<boolean> => {
    if (!previousWorkloadId) return false;
    try {
      const store = retentionStore(kv);
      for (const ledgerKey of await store.keys(RETENTION_LEDGER_FILTER)) {
        const held = await store.read(ledgerKey);
        if (!held) continue;
        const record = JSON.parse(held.value) as { workloadId?: string };
        if (record?.workloadId === previousWorkloadId) return true;
      }
      return false;
    } catch (e) {
      // Unreadable is not "retained": refusing the registration keeps the
      // handle naming something that may still be nobody's to take.
      logger.warn(
        { previousWorkloadId, err: (e as Error)?.message ?? String(e) },
        "dag-handles.retention_check_failed",
      );
      return false;
    }
  };
}

async function retainInsteadOfDestroying(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  answer: LiveWorkAnswer,
  binding: HandsBinding,
): Promise<void> {
  // Retention BEFORE the handle release, and this order has been both ways now.
  //
  // Releasing first was an attempt to keep a failed release retryable, on the
  // premise that a throw means the delete did not happen. It does not: a delete
  // whose ACK is lost has committed, and the caller then provisions a
  // replacement that registers cleanly and overwrites the session entry --
  // leaving the retained container with no handle, no retention record and no
  // binding. The same window opens on a crash between the two, and for a DAG
  // that REUSED this container the handle was also its own way back into this
  // path, so losing it first makes the next attempt skip retention entirely.
  //
  // Retaining first means the reference that replaces the handle exists before
  // the handle can go. What that costs is a failed release leaving a stale
  // handle -- which `registerReusedDagHandle` and the create-path registration
  // recover from, by noticing the name belongs to a retained workload and
  // freeing it there.
  await reuseEffects.retainContainer({
    store: retentionStore(kv),
    // The key this binding was read under, not one re-derived from the session
    // id. `readReusableEntry` reads through both names, so during a rolling
    // upgrade the binding it acted on can be the legacy one while the canonical
    // key holds a different generation of the same session -- and re-deriving
    // then deletes that live sibling's binding while leaving the retained
    // container still bound to its own session, which is both halves of the
    // mistake at once. `deleteExpiredRetryRecord` and `releaseRetention` state
    // the same rule: act on the key that was walked, never on a recomputed one.
    sessionKey: binding.key,
    generation: retentionGeneration(sessionId, info),
    binding: info,
    verdict: answer.verdict,
    detail: answer.reason,
  });

  // The DAG's handle goes with the DAG, not with the container it gives up.
  // Leaving it naming the retained workload makes the replacement
  // unregisterable -- `replaceDagHandle` refuses to take a name from a workload
  // still on record, which is right -- so it is freed here, and if that does
  // not land the registration path frees it instead.
  //
  // Safe to release by workload: this is only reached when
  // `entryOwnedByAnother` said no other DAG holds it.
  const retainedWorkload = typeof info.workloadId === "string" ? info.workloadId : "";
  if (retainedWorkload) {
    await reuseEffects.releaseHandlesForWorkload(retainedWorkload).catch((e) => {
      logger.warn(
        { sessionId, workloadId: retainedWorkload, err: (e as Error)?.message ?? String(e) },
        "hands.retain_handle_release_failed",
      );
    });
  }
}

/**
 * The key part a retention takes: the generation its shells' reference rows
 * record, which is the endpoint that names one sandbox for its whole life.
 *
 * It has to be that exact value and no other. A query naming a shell resolves
 * the container by matching its row's generation against this key part, so a
 * key built from anything else -- a workload id, a sandbox name, a value
 * derived here -- is a container no poll, wait or kill can route back to, which
 * is the addressability the retention exists to keep.
 *
 * @throws where the binding names no endpoint. There is nothing to derive one
 * from that a reference row would agree with, and a retention nothing can
 * resolve protects the work only on paper.
 */
function retentionGeneration(sessionId: string, info: any): string {
  const generation = typeof info.handsUrl === "string" ? info.handsUrl : "";
  if (generation) return generation;
  logger.error({ sessionId }, "ensureHands.retention_generation_absent");
  throw new Error(
    "the sandbox still holds background work and its binding names no endpoint, "
    + "so it could be retained under no key its shells could be routed back through",
  );
}

/**
 * Whether this container may be destroyed, replaced, rebuilt, or evicted.
 *
 * Read from the records over the exec channel before the act, never from the
 * registry: a restarted Hands has an empty registry for reasons that say
 * nothing about the sandbox, so an empty one is never evidence that no work is
 * live.
 */
async function mayDestroy(
  sessionId: string,
  identity: SandboxEntry,
  signal?: AbortSignal,
): Promise<LiveWorkAnswer> {
  const inst = instanceFromEntry(sessionId, identity as never);
  if (!inst) {
    return { verdict: "unknown", classes: {}, reason: "entry_unaddressable" };
  }
  return reuseEffects.countLiveWork(inst, HANDS_STATE_DIR, signal);
}

async function readReusableEntry(
  kv: ReuseAttempt["kv"],
  sessionId: string,
): Promise<{ binding: HandsBinding; info: any } | null> {
  let entry: Awaited<ReturnType<typeof kv.get>>;
  let key = handsSessionKey(sessionId);
  try {
    // Read-through, because an old replica in a rolling upgrade writes and
    // reads only the legacy key: looking at the canonical one alone would read
    // a live session as having no sandbox and provision a second.
    const found = await readHandsEntry(kv, sessionId);
    if (found) key = found.key;
    entry = found?.entry ?? null;
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
    return {
      binding: { key, revision: entry.revision },
      info: parseHandsProbeValue(sc.decode(entry.value)),
    };
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
/**
 * Is this session entry somebody else's to destroy?
 *
 * `hands.<sessionId>` is a single entry, and every replace branch below reads
 * it, takes the workload it names, and stops it. That is right when a session
 * runs one task at a time. Under a session-scoped run gate it is not: two DAG
 * roots take different lock keys and run at once over this one entry, so the
 * workload it names may be one a sibling is still creating -- or already
 * promoted and using. Stopping it is a mis-stop, and no amount of passing the
 * read identity along prevents it: pinning WHICH workload gets stopped is not
 * evidence that it is the caller's to stop.
 *
 * The DAG root is the unit of ownership here, not the task: nodes of the same
 * DAG are meant to share the session's sandbox, and reuse across them is the
 * point. An entry written before these fields existed names nobody, and is
 * treated as the caller's -- the pre-rollout behaviour, and the alternative is
 * refusing to rebuild a session that has no owner recorded.
 */
async function entryOwnedByAnother(
  info: Record<string, unknown>,
  request: ExecuteRequest,
): Promise<boolean> {
  const mineRoot = request.dag_root_task_id ?? request.task_id ?? null;
  const entryRoot = typeof info.dagRootTaskId === "string" ? info.dagRootTaskId : null;
  if (!entryRoot || !mineRoot) return false;

  // Who WROTE the entry is not the same question as who holds the workload now.
  // A task that reused another's sandbox registers its own handle on it and is
  // from then on just as much a holder -- but the entry still names whoever
  // created it. Refusing on that alone left such a task unable to rebuild a
  // sandbox that had broken under it: the replace was skipped as somebody
  // else's, and its own handle, still naming the dead workload, then refused
  // the registration of the replacement. Two attempts, two rolled-back
  // workloads, no way forward.
  //
  // So the handle registry decides. A read failure answers "not mine", which
  // keeps the mis-stop this guard exists to prevent.
  // Not the workload id alone: an agent-sandbox entry records `workloadId: ""`
  // and names its Router session instead, so keying on the workload id meant
  // every ownership question about one was answered "nobody else holds it"
  // without a single query being made -- and a Router sandbox another DAG was
  // using got deleted on the strength of it.
  const workloadId = handleIdentityKey({
    workload_id: typeof info.workloadId === "string" ? info.workloadId : "",
    session_id: typeof info.sessionId === "string" ? info.sessionId : "",
  });
  if (!workloadId) return entryRoot !== mineRoot;
  try {
    // Two questions, and destroying needs both answered. The first is "am I
    // entitled to this sandbox at all" -- true if I created it, and equally
    // true if I merely reused it, because a reusing DAG registers its own
    // handle and is from then on just as much a holder.
    //
    // The second is the one being entitled does not answer: is anyone ELSE
    // holding it? Reuse is the point of the registry, so the answer is often
    // yes -- and creating the workload does not exempt you from asking. A
    // creator whose sandbox has since been reused by another DAG was skipping
    // straight past both queries and stopping it underneath them.
    const entitled = entryRoot === mineRoot
      || await reuseEffects.dagHoldsWorkload(mineRoot, workloadId);
    if (!entitled) return true;
    return await reuseEffects.workloadHeldByOtherDag(mineRoot, workloadId);
  } catch (e) {
    logger.warn(
      { sessionId: request.session_id, workloadId, dagRoot: mineRoot,
        err: (e as Error)?.message ?? String(e) },
      "hands.kv.owner_check_failed",
    );
    return true;
  }
}

export async function tryReuseSessionSandbox(a: ReuseAttempt): Promise<EnsureHandsResult | null> {
  const { kv, sessionId, request, multiNodeContext, requestedSpec, onEvent, signal } = a;
  logger.info({ sessionId }, "ensureHands.kv_lookup");
  const recorded = await readReusableEntry(kv, sessionId);
  if (!recorded) return null;
  const { binding, info } = recorded;

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
    if (await entryOwnedByAnother(info, request)) {
      logger.warn(
        { sessionId, workloadId: info.workloadId, entryDagRoot: info.dagRootTaskId ?? null },
        "hands.kv.mn_replace_skipped_other_owner",
      );
      return null;
    }
    await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    return null;
  }

  if (info.status !== "ready") {
    // "Stale" is an assumption, and under a session-scoped run gate it is
    // sometimes wrong: two DAG roots take different lock keys and run at once
    // over this one entry, so a pending entry can be a sibling's create still
    // in flight rather than this task's own leftover. Destroying it stopped a
    // workload the sibling went on to promote and use.
    //
    // Whoever wrote it says so on the entry. Somebody else's is left where it
    // is -- this task cannot reuse it either, so it falls through to creating
    // its own, which is what it would have done anyway.
    const entryTask = typeof info.taskId === "string" ? info.taskId : null;
    const mine = (!entryTask || !request.task_id || entryTask === request.task_id)
      && !(await entryOwnedByAnother(info, request));
    logger.warn(
      { sessionId, workloadId: info.workloadId, status: info.status ?? "(none)",
        entryTaskId: entryTask, taskId: request.task_id ?? null, mine },
      mine ? "hands.kv.stale_pending_found" : "hands.kv.pending_belongs_to_other_task",
    );
    if (mine) {
      await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    }
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
    if (await entryOwnedByAnother(info, request)) {
      logger.warn(
        { sessionId, workloadId: info.workloadId, entryDagRoot: info.dagRootTaskId ?? null },
        "hands.kv.spec_rebuild_skipped_other_owner",
      );
      return null;
    }
    await reuseEffects.destroyHands(sessionId, identity, hasToken ? info.token : undefined);
    return null;
  }

  const health = await checkHandsHealth(info.handsUrl as string, REUSE_HEALTH_TIMEOUT_MS, signal);
  if (health.ok && hasToken) {
    logger.info(
      { sessionId, handsUrl: info.handsUrl, specMatch: verdict.reason },
      "ensureHands.reusing_existing",
    );
    return acceptExistingSandbox(kv, sessionId, info, identity, binding);
  }
  return recoverOrRetainUnusableSandbox(a, info, identity, binding, health, hasToken);
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
 *
 * Returns false when the binding is gone rather than contended -- the idle
 * sweep deleted it and released its admission slot while we were reactivating,
 * so reusing this sandbox would put a ping target back on the fleet holding no
 * slot and carry the target set past the ceiling.
 */
async function clearIdleMarkers(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  identity: SandboxEntry,
  binding: HandsBinding,
): Promise<boolean> {
  if (info.keepalive === undefined && info.idleSince == null) return true;
  // Same reason the retry below skips these: `keepalive:false` is what marks a
  // handle parked, and eligibleForClusterReclaim refuses any entry whose
  // keepalive is not false, so clearing it here would strip a session delete's
  // parking and strand its GPU clusters. The retry was guarded and this, the
  // path that runs when the entry is already parked at first read, was not.
  if (info.sessionDeleted === true) {
    logger.warn({ sessionId }, "ensureHands.idle_markers_left_parked");
    return true;
  }
  delete info.keepalive;
  delete info.idleSince;
  const { key } = binding;
  const payload = sc.encode(JSON.stringify(info));
  try {
    await kv.update(key, payload, binding.revision);
    return true;
  } catch (err) {
    // Only a lost race falls through to the re-read. A bucket that is actually
    // unavailable is not a race, and retrying it here would just fail twice --
    // the markers stay, and the sandbox is still reusable.
    if (!isRevisionConflict(err)) {
      logger.warn({ err: String(err), sessionId }, "ensureHands.idle_markers_not_cleared");
      return true;
    }
  }
  try {
    const latest = await kv.get(key);
    // Absent or tombstoned: the sweep won the race and took the slot with it.
    if (!latest || isTombstone(latest)) {
      logger.warn({ sessionId, key }, "ensureHands.reuse_record_deleted_under_us");
      return false;
    }
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
      return true;
    }
    if (!sameHandsSandbox(identity, current)) {
      // Someone else's sandbox now. Reusing ours is still correct -- it passed
      // its own health check under its own identity -- but its markers are not
      // ours to clear.
      logger.warn({ sessionId }, "ensureHands.idle_markers_owner_changed");
      return true;
    }
    if (current.keepalive === undefined && current.idleSince == null) return true;
    await kv.update(key, sc.encode(JSON.stringify({
      ...current, keepalive: undefined, idleSince: undefined,
    })), latest.revision);
    return true;
  } catch (err) {
    // Left parked at worst: the ticker will not ping it, and the next request
    // reactivates it. Not a reason to refuse a sandbox that answered.
    logger.warn(
      { err: String(err), sessionId },
      "ensureHands.idle_markers_not_cleared",
    );
    return true;
  }
}


/**
 * Record that this DAG now holds the sandbox it just took over.
 *
 * A failure throws, and attempts to undo the adoption first -- attempts,
 * because the undo can itself report failure and is logged when it does. An
 * unregistered reuse is a sandbox nothing owns on paper, which is how a live
 * pod gets reaped and how a cancel reports that it released everything it
 * could see.
 *
 * `replace` rather than `create`, because the whole point is that a handle of
 * this name may already exist naming the workload this session used before.
 *
 * Exported for the same reason `destroyHandleCas` is on the Backend side: the
 * undo below runs only when a registration failed, which no test reaches
 * through a real KV, and it is the part that has already been wrong twice.
 */
export async function registerReusedDagHandle(
  kv: ReuseAttempt["kv"],
  request: ExecuteRequest,
  action: { kind: string; handle?: string },
  reused: EnsureHandsResult,
): Promise<void> {
  const dagRoot = request.dag_root_task_id ?? request.task_id;
  if (!dagRoot || !action.handle) return;
  const identity = reused.identity;
  if (!identity) return;
  try {
    await replaceDagHandle(dagRoot, action.handle, {
      workload_id: identity.workloadId ?? "",
      hands_url: reused.handsUrl,
      token: reused.token,
      platform_key: identity.platformKey ?? "",
      provider: identity.provider,
      sandbox_name: identity.sandboxName,
      namespace: identity.namespace,
      session_id: identity.sessionId,
      user_id: identity.userId,
    }, { mayTakeFrom: retainedTaker(kv) });
  } catch (e) {
    // Not swallowed. Adopting a sandbox whose ownership could not be recorded
    // hands this DAG a workload that Backend's teardown cannot find: a cancel
    // reports the DAG holds nothing and stops nothing, while the pod keeps its
    // GPU. Failing the turn is loud and retryable; succeeding quietly is how
    // the leak becomes invisible, which is the whole thing this work is about.
    // Throwing alone leaves the adoption half-done. `acceptExistingSandbox`
    // has already cleared the idle markers and registered keepalive, and the
    // runner has not been handed the identity yet -- so nothing downstream can
    // unwind either, `reapPendingHands` skips the READY entry, and the turn's
    // own teardown answers `no_sandbox`. The sandbox stays active, owned by a
    // session whose turn just failed, and unclaimed by any DAG.
    //
    // The adoption is therefore undone rather than abandoned: the sandbox goes
    // back to idle, which is the state it was in a moment ago and the state
    // the next turn expects to find it in. It is deliberately NOT stopped --
    // this path did not create it, and another session's warm pod is not this
    // turn's to destroy on the way out.
    logger.error(
      { dagRoot, handle: action.handle, sessionId: request.session_id,
        err: (e as Error).message },
      "ensureHands.reused_handle_register_failed",
    );
    // The CLAW session, not `identity.sessionId`. For agent-sandbox that field
    // is the Router's session id, while keepalive registrations and the
    // `hands.<session>` key are both keyed by Claw's -- so preferring it sent
    // the unregister and the idle write to a session that does not exist, and
    // the adoption stayed exactly as un-undone as before, with the undo
    // reporting success.
    const adoptedSession = request.session_id;
    try {
      // The two halves of what `acceptExistingSandbox` just did, undone in the
      // reverse order it did them. `unregisterSandbox` drops THIS session's
      // entry from the LOCAL registry. It stops no ticker and recalls no ping
      // already collected into the current tick. It does not make the sandbox
      // unreachable either: keepalive also scans `hands.*` directly, so an
      // entry still marked active is picked up again from KV regardless of the
      // local registry -- which is why the park below is the half that
      // matters, and why its outcome is checked.
      //
      // The order is still the right way round: reversed, the entry reads idle
      // while a live local registration still names it. It is not an atomic
      // handover and nothing here should be read as claiming one.
      //
      // `releaseSlot: false`, which #35 made default true: this is the undo of
      // an ADOPTION, so the sandbox it stops pinging is one somebody else built
      // and is still running. Handing its ceiling slot back lets a new
      // provision take a place the fleet has not actually vacated.
      reuseEffects.unregisterSandbox(adoptedSession, identity, { releaseSlot: false });
      // `markHandsIdle` REPORTS its result rather than throwing -- `parked`,
      // `gone`, `skipped`, `superseded` or `failed` -- so a catch around it
      // establishes nothing, and which of those means "not undone" has to be
      // decided rather than assumed. A conflict is the ordinary case here:
      // the entry is live and its TTL is being refreshed underneath. Left
      // unchecked, the local registration is gone while the KV entry still
      // says active, and the next keepalive tick finds the workload again from
      // KV and goes on pinging a sandbox no turn owns.
      const parked = await reuseEffects.markHandsIdle(kv, adoptedSession, identity);
      // What counts as "the undo did not happen" is narrower than "not
      // parked". `gone` means there is no entry left to park. `skipped` covers
      // three cases, and two of them -- the entry is not READY, or it now
      // names a different sandbox -- mean this adoption's marks are no longer
      // what is there, so there is nothing of ours left to undo. Reporting
      // those would page somebody for an ordinary handover. `unreadable` is
      // the one that does mean the undo was not performed.
      const incomplete = parked.outcome === "superseded"
        || parked.outcome === "failed"
        || (parked.outcome === "skipped" && parked.reason === "unreadable");
      if (incomplete) {
        logger.error(
          { dagRoot, handle: action.handle, sessionId: adoptedSession,
            outcome: parked.outcome, reason: parked.reason },
          "ensureHands.reused_handle_undo_incomplete",
        );
      }
    } catch (undoErr) {
      logger.error(
        { dagRoot, handle: action.handle, sessionId: adoptedSession,
          err: (undoErr as Error).message },
        "ensureHands.reused_handle_undo_failed",
      );
    }
    throw e;
  }
}

/**
 * Keepalive and idle-marker bookkeeping shared by both paths that reuse.
 *
 * Null when the binding was deleted under us, which is the caller's signal to
 * provision instead of reuse: registering a sandbox whose record the sweep just
 * removed re-adds a ping target the roster no longer holds a slot for.
 */
async function acceptExistingSandbox(
  kv: ReuseAttempt["kv"],
  sessionId: string,
  info: any,
  identity: SandboxEntry,
  binding: HandsBinding,
): Promise<EnsureHandsResult | null> {
  // Reactivate a post-task idle reuse handle: clear the keepalive:false marker
  // so the ticker resumes owning it as an active session and
  // stopKeepaliveAfterTask re-marks it idle when this task ends. A handle with
  // no markers needs no write at all -- the entry that passed the gate is
  // already the entry we want.
  if (!await clearIdleMarkers(kv, sessionId, info, identity, binding)) return null;
  // Before the local registration, which is what makes this replica ping it:
  // provisioning is not the only way a ping target is taken on, and a reuse
  // admitted against an uncounted fleet is the same unadmitted target by a
  // path that never claims a slot.
  assertFleetCensused(sessionId);
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
    if (reused) {
      // A sandbox taken by reuse is held just as firmly as one that was
      // created, and until now only the created case was ever registered: this
      // path returned early, so the DAG that reused a warm pod owned it while
      // the handle map still named whichever task created it.
      //
      // Two consequences, both reachable without any race. Backend's teardown
      // for this DAG finds an empty map and reports it holds nothing, so a
      // cancel stops nothing and says so confidently. And the sweeper, reading
      // only the creating task, sees that task terminal and tears the sandbox
      // down under the DAG now running on it. Ownership has to move with the
      // sandbox, and this is the moment it moves.
      await registerReusedDagHandle(kv, request, action, reused);
      return reused;
    }
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
  // Before the provider is called at all: a ceiling checked once the sandbox
  // exists is not a ceiling, because two provisions racing the last slot both
  // start and both are then live work nothing may evict.
  const hold = await admitSandbox(sessionId);
  const onProvisioned = makeOnProvisioned({
    sessionId, namespace: nsForSandbox, apiKey, handsToken, sandboxImage, kv, hold,
    // The handle this DAG is claiming, and who is claiming it. Needed inside
    // because the registration has to happen in this hook -- see the note there.
    taskId: request.task_id ?? null,
    dagRootTaskId: request.dag_root_task_id ?? request.task_id ?? null,
    handleName: action.kind === "create" ? (action.handle ?? null) : null,
  });

  logger.info({ sessionId, sandboxImage, namespace: nsForSandbox }, "ensureHands.creating_workload");

  let inst;
  try {
    inst = await getSafeWorkloadProvider().create({
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
  } catch (err) {
    await hold.release();
    throw err;
  }
  // Set once the sandbox is a registered ping target, which is the point past
  // which its slot is the sweep's to renew. Anything short of that -- bootstrap,
  // health, the durable record -- gives the reservation back rather than
  // holding capacity for a sandbox nobody will ping.
  let admitted = false;
  try {
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
      const tail = await getSafeWorkloadProvider().exec(inst, `tail -c 2000 ${HANDS_LOG_PATH} 2>&1 || true`, "15s");
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
  const kvKey = handsSessionKey(sessionId);
  const readyPayload = sc.encode(JSON.stringify({
    status: "ready",
    // Who this sandbox belongs to -- see the note on `entryOwnedByAnother`.
    taskId: request.task_id ?? null,
    dagRootTaskId: request.dag_root_task_id ?? request.task_id ?? null,
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
  admitted = true;

  // task-design.md §9.4: when the calling task belongs to a DAG and declared
  // a sandbox.handle name, publish a HandleInfo to the DagHandleMap so any
  // downstream node with `sandbox.use=<handle>` can short-circuit ensureHands
  // and connect directly to this workload. A failure here is fatal and rolls
  // the workload back: the handle is also the only record Backend has of what
  // this DAG holds.
  const dagRoot = request.dag_root_task_id ?? request.task_id;
  // `replace`, not `create`. A create refuses a name that already maps
  // elsewhere -- correct against a double-create, wrong here, because this IS
  // the moment a handle legitimately changes hands: a rebuild has just stopped
  // the previous workload and this is its replacement. Rejected and swallowed,
  // as it was, the map goes on naming a workload that is gone while the new
  // one runs unreferenced, so a later cancel stops the corpse, hears 404 or
  // 200, and reports the sandbox released.
  if (dagRoot && action.kind === "create" && action.handle) {
    try {
      await replaceDagHandle(dagRoot, action.handle, {
        workload_id: workloadId,
        hands_url: handsUrl,
        token: handsToken,
        platform_key: apiKey || "",
        image: workloadImage,
        // Keepalive polls this namespace. The use-path falls back to the
        // deployment default when the field is missing, so a workspace-scoped
        // sandbox would be polled where it is not and expire while still live.
        namespace: nsForSandbox,
      }, { mayTakeFrom: retainedTaker(kv) });
    } catch (e) {
      // Was non-fatal, on the reasoning that a DAG can still complete without
      // reuse. It can -- but the handle is also the only record Backend has of
      // what this DAG holds, so a swallowed failure leaves a live workload
      // that a cancel reports as `nothing_held` and never stops. Losing reuse
      // is a cost; losing the ability to account for a GPU is not one to take
      // silently.
      //
      // Throwing is not enough on its own: the workload is already created and
      // its `hands.<session>` entry is already READY, and the failure cleanup
      // above this only reaps PENDING entries. So the turn would fail with the
      // GPU still allocated. The early registration usually still names it --
      // this write was enriching that entry, not creating it -- so it is not
      // necessarily unreferenced; it is simply not released, which is what the
      // teardown here is for, in the same shape as the pending write's own
      // rollback.
      logger.error(
        { sessionId, dagRoot, handle: action.handle, workloadId, err: (e as Error).message },
        "ensureHands.handle_register_failed_rollback",
      );
      await reuseEffects.destroyHands(sessionId, identity, handsToken).catch((cleanupErr) => {
        // Logged with the id: if the early registration is also gone, this
        // line is what is left to find the workload by.
        logger.error(
          { sessionId, workloadId, err: (cleanupErr as Error).message },
          "ensureHands.handle_register_rollback_failed",
        );
      });
      throw e;
    }
  }

  return { handsUrl, created: true, token: handsToken, identity };
  } finally {
    if (!admitted) await hold.release();
  }
}


/**
 * The provisioning hook a SaFE create runs the moment a workload id exists.
 *
 * Its own function because both things it does are rollback obligations, and a
 * rollback nothing can call is not one: the workload already exists by the time
 * this runs, so a failure here has to take it down using the id only this hook
 * holds -- the caller's own catch sees `create` rejecting and has no handle at
 * all. Exported so the obligation is exercised where production installs it,
 * rather than through a stand-in that would stay green if the call were
 * deleted.
 */
export function makeOnProvisioned(deps: {
  sessionId: string;
  namespace: string;
  apiKey: string;
  handsToken: string;
  sandboxImage: string | null;
  kv: KV;
  hold: AdmissionHold;
  stop?: (workloadId: string) => Promise<void>;
  /** Who this workload belongs to, and the handle it is claiming. */
  taskId?: string | null;
  dagRootTaskId?: string | null;
  handleName?: string | null;
}): (workloadId: string) => Promise<void> {
  const stopWorkload = deps.stop ?? (async (workloadId: string) => {
    await getSafeWorkloadProvider().stop({
      provider: "safe-workload", id: workloadId, sandboxName: workloadId,
      namespace: deps.namespace, handsBaseUrl: "", platformKey: deps.apiKey,
    });
  });

  /**
   * Take down a workload this call created and cannot finish tracking.
   *
   * A stop that fails is not swallowed: the workload is then live, holding no
   * admission slot and named by no record, which is precisely the untracked
   * target both the rollback and the ceiling exist to prevent. Raised with both
   * causes so an operator sees the one that started it.
   */
  const rollback = async (workloadId: string, cause: unknown): Promise<never> => {
    try {
      await stopWorkload(workloadId);
    } catch (stopErr) {
      logger.error(
        { sessionId: deps.sessionId, workloadId, err: (stopErr as Error)?.message },
        "hands.rollback_stop_failed",
      );
      throw new Error(
        `workload ${workloadId} could not be stopped after ${(cause as Error)?.message}: `
        + `${(stopErr as Error)?.message}. It is running, unadmitted and untracked.`,
      );
    }
    throw cause;
  };

  return async (workloadId: string): Promise<void> => {
    // The reservation stops naming a token and starts naming a target here --
    // ahead of the durable record below, of bootstrap, and of registration.
    try {
      await deps.hold.bind(pingTargetIdentity({
        provider: "safe-workload", workloadId,
      }));
    } catch (bindErr) {
      logger.error({ sessionId: deps.sessionId, workloadId }, "hands.admission.bind_failed_rollback");
      await rollback(workloadId, bindErr);
    }

    const pendingPayload = sc.encode(JSON.stringify({
      status: "pending", workloadId, sandboxImage: deps.sandboxImage,
      // Who this entry belongs to. `hands.<sessionId>` is one slot and a
      // session can hold more than one DAG at a time under a session-scoped run
      // gate, so a failing task must be able to tell its own half-created
      // workload from a sibling's live one before reaping it.
      taskId: deps.taskId ?? null,
      dagRootTaskId: deps.dagRootTaskId ?? null,
      platformKey: deps.apiKey, token: deps.handsToken, namespace: deps.namespace,
      createdAt: new Date().toISOString(),
    }));

    // Phase (A) for the DAG handle, written BEFORE the session entry below.
    //
    // Both records are made in this hook for the same reason: the workload
    // exists from this moment, and everything between here and the registration
    // at the end of ensureHands -- poll, bootstrap, health -- is time in which a
    // cancel can arrive. It found no handle, concluded the DAG held nothing, and
    // reported exactly that while the workload it missed kept its GPU.
    //
    // Their ORDER matters because only one of them is what a cancel reads.
    // Backend decides whether a DAG holds a sandbox from the handle map, so
    // every instant in which the session entry exists and the handle does not is
    // an instant a cancel answers `nothing_held` over a live workload. This way
    // round, the worst it sees is a handle whose session entry has not landed
    // yet -- which errs towards reporting a workload that is there, the
    // direction this whole change exists to err in.
    //
    // A registration that cannot be written rolls the workload back, exactly as
    // the pending write below does: an unregisterable workload is one nothing
    // can account for, and it must not outlive this call.
    if (deps.dagRootTaskId && deps.handleName) {
      try {
        await replaceDagHandle(deps.dagRootTaskId, deps.handleName, {
          workload_id: workloadId,
          // Not serving yet: SaFE has an id for it, but it can still be queued
          // for a GPU. Readers that ping what a handle names have to be able to
          // tell this row from one that finished provisioning.
          pending: true,
          platform_key: deps.apiKey || "",
          image: deps.sandboxImage ?? undefined,
          namespace: deps.namespace,
        }, { mayTakeFrom: retainedTaker(deps.kv) });
      } catch (err) {
        logger.error(
          { sessionId: deps.sessionId, workloadId, dagRoot: deps.dagRootTaskId,
            handle: deps.handleName, err: (err as Error).message },
          "dag-handles.pending_register_failed_rollback",
        );
        await rollbackUnregisterableWorkload({
          sessionId: deps.sessionId, workloadId, namespace: deps.namespace,
          platformKey: deps.apiKey, pendingPayload, kv: deps.kv,
          deps: { stop: async (id) => { await stopWorkload(id); } },
        });
        throw new Error(
          `DAG handle registration failed for workload ${workloadId}, rolled back`,
        );
      }
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deps.kv.put(handsSessionKey(deps.sessionId), pendingPayload);
        logger.info({ sessionId: deps.sessionId, workloadId }, "hands.kv.pending");
        return;
      } catch (kvErr) {
        logger.warn(
          { err: (kvErr as Error)?.message, sessionId: deps.sessionId, workloadId, attempt },
          "hands.kv.pending_put_retry",
        );
        if (attempt < 3) await sleep(200);
      }
    }
    logger.error({ sessionId: deps.sessionId, workloadId }, "hands.kv.pending_put_failed_rollback");
    // Same two remedies as the registration rollback above, so the same helper:
    // whichever of stop / session-entry lands first is enough, and the pending
    // write it retries is a fourth attempt at the one that just failed three
    // times -- by now KV may have come back. It also keeps trying in the
    // background when neither lands, which `rollback` alone cannot.
    const outcome = await rollbackUnregisterableWorkload({
      sessionId: deps.sessionId, workloadId, namespace: deps.namespace,
      platformKey: deps.apiKey, pendingPayload, kv: deps.kv,
      deps: { stop: async (id) => { await stopWorkload(id); } },
    });
    if (outcome === "orphaned") {
      // main's wording, and still the right one: nothing durable could be
      // written and the stop would not land, so it is running, unadmitted and
      // untracked -- with a bounded background retry still trying.
      throw new Error(
        `workload ${workloadId} could not be stopped after KV pending write failed. `
        + "It is running, unadmitted and untracked.",
      );
    }
    throw new Error(`KV pending write failed for workload ${workloadId}, rolled back`);
  };
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

/**
 * A rollback attempt makes at most this many rounds of it. Both remedies are
 * retried because the single thing that must not happen -- a live workload no
 * record points at -- survives one transient failure of either.
 */
export const ROLLBACK_ATTEMPTS = 3;

/**
 * Backoff for the detached recovery that runs when every synchronous round
 * failed. Spread over ~8 minutes, because what it is waiting for is a SaFE or
 * KV outage ending, and one attempt after that is enough.
 */
export const ORPHAN_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Undo a workload whose DAG handle could not be registered.
 *
 * The registration failing does not say WHY it failed, and the two reasons want
 * opposite things:
 *
 *   - **Refused**, because the name still belongs to an older workload. This
 *     workload has no handle and never will get one, so nothing in the handle
 *     map will ever lead back to it.
 *   - **Committed, ACK lost.** The handle already names THIS workload, so
 *     leaving it in place means every later attempt is refused against a corpse.
 *
 * Two remedies, and EITHER one is enough. Stopping the workload is the better
 * of them -- a workload that no longer exists needs no record -- so it is tried
 * first each round. Failing that, the pending session entry makes it findable,
 * which matters because this path returns before the caller writes that entry,
 * so without it the only trace of a running workload is a log line and
 * `reapPendingHands` has nothing to retry.
 *
 * Each round tries the stop, then the record; the loop ends the moment one of
 * them lands. One-shotting either of them was the defect this replaces: the
 * normal pending write retries three times, and the rollback's did not, so a
 * single transient KV error on a workload whose stop had also failed left it
 * running and unreferenced.
 *
 * Releasing the handle happens only after a stop that SUCCEEDED, and is keyed
 * by workload, so it removes nothing if the registration really was refused.
 * It is retried too: a stop that landed and a release that did not leaves the
 * name pointing at something that is gone.
 */
export async function rollbackUnregisterableWorkload(args: {
  sessionId: string;
  workloadId: string;
  namespace: string;
  platformKey: string;
  pendingPayload: Uint8Array;
  kv: {
    get: (key: string) => Promise<{ value?: Uint8Array; revision: number; operation?: string } | null>;
    create: (key: string, value: Uint8Array) => Promise<unknown>;
    update: (key: string, value: Uint8Array, revision: number) => Promise<unknown>;
  };
  deps?: {
    stop?: (workloadId: string, namespace: string, platformKey: string) => Promise<unknown>;
    release?: (workloadId: string) => Promise<unknown>;
    /** Test seam: run the detached recovery inline instead of in the background. */
    detach?: (fn: () => Promise<void>) => void;
    /** Test seam: the backoff between recovery attempts. */
    retryDelaysMs?: number[];
  };
}): Promise<"stopped" | "recorded" | "orphaned"> {
  const { sessionId, workloadId, namespace, platformKey, pendingPayload, kv } = args;
  const stop = args.deps?.stop ?? ((id: string, ns: string, key: string) =>
    getSafeWorkloadProvider().stop({
      provider: "safe-workload", id, sandboxName: id,
      namespace: ns, handsBaseUrl: "", platformKey: key,
    }));
  const release = args.deps?.release ?? releaseHandlesForWorkload;

  // Writing the session entry is only a remedy while the entry is still THIS
  // workload's to write. The background recovery below can wake long after the
  // task that owned it failed and the session moved on to a new workload, and
  // `hands.<sessionId>` holds one entry: writing the old pending payload over a
  // live one takes the new workload's only reference to give the old one a
  // reference that the new workload's own `ready` write then overwrites. Both
  // end up unreferenced, and the loop -- having counted the write as success --
  // has already exited.
  //
  // So it reads first, and declines when the entry names someone else. That is
  // not a failure to retry: the entry is spoken for and will stay spoken for,
  // and stopping the workload is the remedy that remains. Absent, tombstoned or
  // still ours, the write is revision-conditional, so a session entry that
  // appears between the read and the write is not overwritten either.
  const recordPending = async (): Promise<boolean> => {
    // Read through BOTH names, write the canonical one -- the same rule
    // `readReusableEntry` follows, and for the same reason. #35 introduced the
    // canonical key and a migration that resolves the two by `createdAt`, so a
    // check that looks at one name can miss a live binding held under the
    // other: during a rolling upgrade the live one can be the legacy name,
    // this writes a newer pending on the canonical name, and the migration then
    // deletes the live binding as the older of the pair. Before the merge the
    // two names were the same string and one read saw everything.
    // BOTH keys, read explicitly -- not `readHandsEntry`, which is
    // canonical-first and returns the first non-null it finds. That is right for
    // "which binding is in force" and wrong for "is this slot free": when the
    // canonical key holds a tombstone, an empty PUT, or this workload's own
    // row, the read-through stops there and never sees another workload holding
    // the legacy name. The migration then merges the two by `createdAt` and
    // deletes that live binding as the older of the pair.
    const key = handsSessionKey(sessionId);
    const names = [key, `hands.${sessionId}`].filter((n, i, a) => a.indexOf(n) === i);
    let found: { key: string; entry: NonNullable<Awaited<ReturnType<typeof kv.get>>> } | null = null;
    for (const name of names) {
      const e = await kv.get(name);
      if (!e) continue;
      const usable = e.operation !== "DEL" && e.operation !== "PURGE"
        && (e.value?.length ?? 0) > 0;
      // A row that names somebody else decides the answer wherever it is found,
      // so it wins over a tombstone the other name happens to hold.
      if (usable) { found = { key: name, entry: e }; break; }
      found ??= { key: name, entry: e };
    }
    const cur = found?.entry ?? null;
    if (cur) {
      // A key that exists is replaced by revision, whatever state it is in.
      // Splitting on "has a usable value" and routing the rest to `create` was
      // a regression: the heartbeat re-`update`s tombstones it read, and NATS
      // does not carry the DEL operation across an update, so the bucket holds
      // a PUT with a zero-byte value. `create` allows an absent key or a
      // tombstone -- not that -- so it conflicted on every attempt, where the
      // unconditional `put` this replaced simply succeeded.
      const live = cur.operation !== "DEL" && cur.operation !== "PURGE"
        && (cur.value?.length ?? 0) > 0;
      let claimedByOther = false;
      if (live) {
        try {
          claimedByOther = JSON.parse(sc.decode(cur.value!)).workloadId !== workloadId;
        } catch { /* unparseable: nothing is relying on it, so it may be replaced */ }
      }
      if (claimedByOther) {
        logger.warn(
          { sessionId, workloadId },
          "dag-handles.pending_register_rollback_session_reused",
        );
        return false;
      }
      // The key it was actually read under, never a re-derived one: updating
      // the canonical name on the strength of a legacy read is the lost update
      // this whole check exists to avoid.
      await kv.update(found?.key ?? key, pendingPayload, cur.revision);
      return true;
    }
    await kv.create(key, pendingPayload);
    return true;
  };

  const attemptRemedies = async (rounds: number): Promise<"stopped" | "recorded" | null> => {
    let stopped = false;
    let recorded = false;
    // `!recorded` only: a landed stop `break`s out two lines below, so testing
    // `!stopped` here could never be false. Flagged by CodeQL, and correctly --
    // the break is what ends that case, and the condition was decoration.
    for (let attempt = 1; attempt <= rounds && !recorded; attempt++) {
      try {
        await stop(workloadId, namespace, platformKey);
        stopped = true;
        break;
      } catch (stopErr) {
        logger.error(
          { sessionId, workloadId, attempt, err: (stopErr as Error)?.message ?? String(stopErr) },
          "dag-handles.pending_register_rollback_stop_failed",
        );
      }
      try {
        recorded = await recordPending();
      } catch (kvErr) {
        logger.error(
          { sessionId, workloadId, attempt, err: (kvErr as Error)?.message ?? String(kvErr) },
          "hands.kv.pending_put_after_failed_rollback_failed",
        );
        if (attempt < rounds) await sleep(200);
      }
    }

    if (stopped) {
      for (let attempt = 1; attempt <= ROLLBACK_ATTEMPTS; attempt++) {
        try {
          await release(workloadId);
          break;
        } catch (e) {
          logger.error(
            { sessionId, workloadId, attempt, err: (e as Error)?.message ?? String(e) },
            "dag-handles.pending_register_rollback_release_failed",
          );
          if (attempt < ROLLBACK_ATTEMPTS) await sleep(200);
        }
      }
      return "stopped";
    }
    return recorded ? "recorded" : null;
  };

  const outcome = await attemptRemedies(ROLLBACK_ATTEMPTS);
  if (outcome === "stopped") return outcome;

  // Neither remedy landed in any round: SaFE would not stop it and KV would not
  // take the record. Nothing durable can be written, because those two ARE the
  // only durable stores this process has -- so there is no record to leave for
  // a sweep to find, and the caller is about to throw.
  //
  // What the exhausted case has that the caller does not is the workload id, so
  // it keeps trying in the background. Both of these failures are transient by
  // hypothesis -- a 503 and an unreachable KV -- and the moment either
  // dependency comes back, one attempt is enough to either stop the workload or
  // make it findable. Detached deliberately: the task this belonged to has
  // already failed and must not wait on a recovery that may never come.
  //
  // What this does NOT survive is the process dying inside the retry window, and
  // it cannot: recording the workload somewhere that outlives the process is
  // exactly the workload-keyed durable ownership this PR defers.
  //
  // A session entry that WAS written does not end it either. `hands.<sessionId>`
  // is one slot, owned by whichever workload the session is currently creating,
  // and the next normal pending write takes it back unconditionally -- so a
  // recovery that recorded W1 and exited left W1 unreferenced again the moment
  // W2 finished provisioning, with nothing still trying. Only a landed stop
  // means there is no longer a workload to keep track of.
  if (!outcome) {
    logger.error(
      { sessionId, workloadId, namespace },
      "dag-handles.pending_register_rollback_orphaned",
    );
  } else {
    logger.warn(
      { sessionId, workloadId, namespace },
      "dag-handles.pending_register_rollback_recorded_pending_stop",
    );
  }
  const detach = args.deps?.detach ?? ((fn: () => Promise<void>) => { void fn().catch(() => {}); });
  const delays = args.deps?.retryDelaysMs ?? ORPHAN_RETRY_DELAYS_MS;
  detach(async () => {
    for (const delay of delays) {
      await sleep(delay);
      const recovered = await attemptRemedies(1);
      if (recovered === "stopped") {
        logger.warn(
          { sessionId, workloadId, outcome: recovered },
          "dag-handles.pending_register_rollback_orphan_recovered",
        );
        return;
      }
    }
    logger.error(
      { sessionId, workloadId, namespace },
      "dag-handles.pending_register_rollback_orphan_retry_exhausted",
    );
  });
  return outcome ?? "orphaned";
}

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
  // Claimed before the provider is called, so two provisions racing the last
  // slot cannot both start; bound below at the first moment an identity exists.
  const hold = await admitSandbox(sessionId);
  let inst;
  try {
    inst = await provider.create({
      sessionId,
      namespace: ns,
      image: workloadImage,
      resources: action.params.resources,
      env,
      labels,
      timeoutSec: action.params.timeout,
      userId,
    });
  } catch (err) {
    await hold.release();
    throw err;
  }
  let admitted = false;
  try {
    // The identity the sweep will ping, field for field, or the slot names a
    // target nobody looks for and the sandbox reads as un-admitted.
    await hold.bind(pingTargetIdentity({
      provider: "agent-sandbox",
      sessionId: inst.id,
      sandboxName: inst.sandboxName,
      namespace: inst.namespace,
    }));
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
        const tail = await provider.exec(inst, `tail -c 2000 ${HANDS_LOG_PATH} 2>&1 || true`, "15s");
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
    await kv.put(handsSessionKey(sessionId), sc.encode(JSON.stringify({
      status: "ready",
      // Who this sandbox belongs to -- see the note on `entryOwnedByAnother`.
      taskId: request.task_id ?? null,
      dagRootTaskId: request.dag_root_task_id ?? request.task_id ?? null,
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
    admitted = true;

    // task-design.md §9.4: publish the handle so downstream DAG nodes with
    // `sandbox.use=<handle>` can re-attach. agent-sandbox has no workload_id,
    // so carry the provider + agent-sandbox identity for the use path. A
    // failure here is fatal and tears the sandbox down, as on the SaFE path.
    const dagRoot = request.dag_root_task_id ?? request.task_id;
    // `replace` for the same reason as the SaFE path above: a rebuilt
    // agent-sandbox is a new instance under the same handle name, and a create
    // that refuses it leaves the map naming the instance that was just torn
    // down.
    if (dagRoot && action.handle) {
      try {
        await replaceDagHandle(dagRoot, action.handle, {
          workload_id: "",
          provider: "agent-sandbox",
          session_id: inst.id,
          sandbox_name: inst.sandboxName,
          namespace: inst.namespace,
          user_id: userId,
          hands_url: handsUrl,
          token: handsToken,
          image: workloadImage,
        }, { mayTakeFrom: retainedTaker(kv) });
      } catch (e) {
        // Same reasoning as the SaFE path, rollback included: the sandbox is
        // created and registered for keepalive by now, so failing the turn
        // without tearing it down leaves an allocated sandbox nothing refers
        // to.
        logger.error(
          { sessionId, dagRoot, handle: action.handle, sandboxName: inst.sandboxName,
            err: (e as Error).message },
          "ensureHands.agent.handle_register_failed_rollback",
        );
        await reuseEffects.destroyHands(sessionId, identity, handsToken).catch((cleanupErr) => {
          logger.error(
            { sessionId, sandboxName: inst.sandboxName, err: (cleanupErr as Error).message },
            "ensureHands.agent.handle_register_rollback_failed",
          );
        });
        throw e;
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
  } finally {
    // A bind that could not commit is one of the ways this lands here, and the
    // rollback above has already stopped the sandbox -- which is the obligation
    // a live sandbox holding no slot creates.
    if (!admitted) await hold.release();
  }
}
