// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Multi-node provider for `CLAW_DEPLOY_MODE=safe`: the cluster is a SaFE
 * workload (RayJob or InferaDeployment) created with the requesting user's
 * platform key, exactly as Hyperloom's own `multi_node` CLI would create it.
 *
 * Everything goes through the SaFE API; Brain never talks to Kubernetes. The
 * workload id is pinned to the message id (see sandbox/multi-node/safe-body.ts applyWorkloadId), so
 * adoption and per-message teardown address the cluster directly instead of
 * searching for it. Session teardown, which has no message id to work from,
 * falls back to a `CLAW_SESSION_ID` env query -- SaFE filters and echoes `env`
 * but neither filters nor returns workload labels.
 */

import pino from "pino";
import type { ExecuteRequest } from "@claw/protocol";
import {
  AUTH_INTERNAL_TOKEN,
  MULTI_NODE_DEFAULT_TIMEOUT_SECONDS,
  SAFE_API_URL,
} from "../../config.js";
import { normalizeWorkloadTimeout, resolveSandboxImageFromRequest } from "../ensure-hands.js";
import {
  assertMultiNodeInferaModel,
  ephemeralGiPerNode,
  resolveTopology,
  type MultiNodePromptSpec,
} from "./prompt-flags.js";
import { multiNodeWorkloadName } from "../workload-naming.js";
import { SandboxProvisionTerminalError } from "../errors.js";
import { TERMINAL_PHASES, waitForWorkloadReady, type WorkloadWaitDeps } from "../workload-wait.js";
import { parseWorkloadListPage, type WorkloadRef } from "./workload-parse.js";
import {
  buildInferaWorkloadBody,
  buildRayJobWorkloadBody,
  inferaFrontendPort,
  inferaSshPortBase,
  RAYJOB_SERVER_PORT,
  SESSION_ENV,
} from "./safe-body.js";
import {
  discoverRolePods,
  gpuPodsReady,
  headPodIp,
  rayClusterName,
  type RolePodGroups,
} from "./safe-pods.js";
import { deriveSessionKeypair, type SshKeypair } from "./ssh-key.js";
import type {
  MultiNodeBackend,
  MultiNodeContext,
  MultiNodeEnsureOptions,
  MultiNodeEventSink,
  MultiNodeProvider,
  SessionDestroyResult,
} from "./types.js";

const logger = pino({ name: "multi-node-safe" });

/** Rows per request when walking a session's workloads. */
const SESSION_PAGE_SIZE = 200;

/**
 * Cap on pages walked for one session, so a totalCount that never gets satisfied
 * cannot loop forever. Hitting it is reported as incomplete rather than assumed
 * clean.
 */
const SESSION_MAX_PAGES = 20;

/**
 * SaFE's non-terminal WorkloadPhase values, in SaFE's own casing.
 *
 * Sent to the list endpoint so a session's finished workloads stay out of both the
 * page and its totalCount. Nothing ever removes them from that list -- a sandbox is
 * retired with `stop`, which only moves it to `Stopped`, and only an actual DELETE
 * sets `is_deleted` -- so unfiltered they accumulate for the life of a session.
 *
 * A whitelist over a closed set: WorkloadPhase in SaFE's api package
 * (apis/pkg/apis/amd/v1/workload_types.go) defines exactly Succeeded, Failed,
 * Pending, Running, Updating, NotReady and Stopped, and the four non-terminal ones
 * are listed here.
 *
 * It has to be updated alongside that enum, in a different repository, and getting
 * that wrong is silent: a new non-terminal phase left out would be filtered from
 * the page AND from totalCount, so the shortfall check -- which compares exactly
 * those two -- could not notice it either. The session would report clean and its
 * clusters would run to the workload's own timeout. The client-side TERMINAL_PHASES
 * skip stays for that reason, covering the case where this filter does not apply.
 */
const ACTIVE_PHASES = "Pending,Running,Updating,NotReady";

/**
 * SaFE kinds that are GPU clusters. Used to spare the session's own sandbox,
 * which carries the same `CLAW_SESSION_ID` env and would otherwise be swept.
 */
const CLUSTER_KINDS = new Set(["RayJob", "InferaDeployment"]);

/** Where the Infera private key is materialised inside the sandbox. */
const SANDBOX_SSH_KEY_PATH = "/tmp/primus-claw-mn-ssh-key";

interface SafeFetchOptions {
  method?: string;
  apiKey: string;
  body?: unknown;
  timeoutMs?: number;
}

async function safeFetch(path: string, opts: SafeFetchOptions): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${SAFE_API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await resp.text().catch(() => "");
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error body; keep the raw text */
  }
  return { status: resp.status, body: parsed };
}

/** A session's workloads, plus whether the walk saw all of them. */
interface SessionWorkloadPage {
  /** The workloads the walk collected, all of them addressable by id. */
  items: WorkloadRef[];
  /** True when the server reported matches the walk could not hand over. */
  incomplete: boolean;
  /**
   * Which kind of incompleteness, kept apart because they mean different things
   * to the caller: `lookup_failed` is "the list could not be read at all", so
   * nothing is known about the session, while `list_truncated` is "read, but
   * short of what the server reported" -- the items are trustworthy, there are
   * just workloads behind them that no caller can address.
   */
  reason?: "lookup_failed" | "list_truncated";
}

/**
 * Every workload a session owns, sandbox included.
 *
 * `CLAW_SESSION_ID` is set on the Hands sandbox by sandbox/ensure-hands.ts and on each
 * GPU cluster by sandbox/multi-node/safe-body.ts, so this reproduces the reach the
 * `primus-claw/session-id` label selector used to have. SaFE matches the env
 * value exactly (jsonb `->> key = value`), so no other session can be returned.
 */
async function findSessionWorkloads(sessionId: string, apiKey: string): Promise<SessionWorkloadPage> {
  const items: WorkloadRef[] = [];
  let reported = 0;
  for (let page = 0; page < SESSION_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      envKey: SESSION_ENV,
      envValue: sessionId,
      phase: ACTIVE_PHASES,
      // Sort stated rather than inherited from the server's defaults, because these
      // two decide whether a page that does get truncated holds the newest
      // workloads or the oldest -- and the newest are the ones still running.
      sortBy: "creation_time",
      order: "desc",
      limit: String(SESSION_PAGE_SIZE),
      offset: String(page * SESSION_PAGE_SIZE),
    });
    const resp = await safeFetch(`/api/v1/workloads?${query}`, { apiKey });
    if (resp.status !== 200) {
      throw new Error(`workloads list failed: HTTP ${resp.status} ${JSON.stringify(resp.body).slice(0, 300)}`);
    }
    // A 200 whose body is not a workload list hands us nothing to act on and
    // proves nothing about the session. Reported as incomplete rather than
    // thrown: a teardown must refuse to call the session clean, but the idle
    // sweeper is opportunistic and has no such obligation -- it would simply
    // find nothing this pass, exactly as it did before this distinction existed.
    const parsed = parseWorkloadListPage(resp.body);
    if (!parsed) {
      logger.warn(
        { sessionId, page, body: JSON.stringify(resp.body).slice(0, 300) },
        "mn.safe_list_unrecognised",
      );
      return { items, incomplete: true, reason: "lookup_failed" };
    }
    reported = parsed.totalCount;
    items.push(...parsed.items);
    // An empty page ends the walk even when the count says otherwise. The
    // shortfall that leaves is real -- an entry with no id cannot be deleted, so
    // it is a workload we know exists and cannot address -- and it travels back
    // as a flag rather than an exception, because refusing to act on it would
    // let one malformed row strand a whole session's clusters.
    if (parsed.items.length === 0 || items.length >= reported) {
      const short = items.length < reported;
      if (short) {
        logger.warn(
          { sessionId, addressable: items.length, reported },
          "mn.safe_list_incomplete",
        );
      }
      return short ? { items, incomplete: true, reason: "list_truncated" } : { items, incomplete: false };
    }
  }
  logger.warn(
    { sessionId, pages: SESSION_MAX_PAGES, collected: items.length, reported },
    "mn.safe_list_page_cap",
  );
  return { items, incomplete: true, reason: "list_truncated" };
}

/**
 * Reclaim the GPU clusters of a session whose sandbox has gone idle.
 *
 * Complements the two teardown paths that can both be missed: per-message
 * release does not run when Brain dies mid-task, and session teardown only runs
 * when the session is actually deleted. Deliberately spares the sandbox itself,
 * which is kept warm for reuse.
 *
 * @param sessionId Session whose clusters should be reclaimed.
 * @param apiKey SaFE key of the session's owner.
 * @returns How many clusters were deleted.
 */
export async function reclaimIdleSessionClusters(sessionId: string, apiKey: string): Promise<number> {
  // A shortfall is not worth reporting here. It cannot hide a running cluster
  // from this sweep -- the walk above pages through everything non-terminal, so
  // what is missing is an entry with no id, which no caller could delete anyway.
  const { items } = await findSessionWorkloads(sessionId, apiKey);
  let deleted = 0;
  for (const ref of items) {
    if (!CLUSTER_KINDS.has(ref.kind)) continue;
    if (TERMINAL_PHASES.has(ref.phase)) continue;
    const resp = await safeFetch(`/api/v1/workloads/${ref.id}`, { method: "DELETE", apiKey })
      .catch((e) => ({ status: 0, body: String(e) }));
    if ([200, 202, 204, 404].includes(resp.status)) {
      logger.info({ sessionId, workloadId: ref.id, kind: ref.kind }, "mn.safe_idle_reclaimed");
      deleted += 1;
    } else {
      logger.warn({ sessionId, workloadId: ref.id, status: resp.status }, "mn.safe_idle_reclaim_failed");
    }
  }
  return deleted;
}

/**
 * Status label for a provisioning event.
 *
 * Prefixed with the actual backend so an infera run never reports itself as a
 * RayJob; the suffix is unchanged so consumers matching on the phase
 * (`*_creating` / `*_provisioning` / `*_ready` / `*_reused` / `*_failed`) keep
 * working.
 */
function mnStatus(backend: MultiNodeBackend, phase: string): string {
  return `${backend}_${phase}`;
}

/** Where a failed ensure() got to, for consumers that group these events. */
export type MultiNodeFailurePhase = "create" | "terminal" | "wait" | "config";

/**
 * Classify a failed ensure().
 *
 * Read off the error's own reason when the wait raised it, rather than off its
 * wording: matching on text meant that rewording a message silently relabelled
 * the failure, which is what happened when the wait moved into
 * sandbox/workload-wait.ts. A terminal SaFE phase is reported as such; every other way
 * the wait can end -- an unreadable status, a workload that has gone, a queue
 * ceiling, a pod that exited -- is a cluster that did not come up, so all of
 * them read `wait`.
 *
 * `config` is the catch-all, and is meant to stay one: the body builders'
 * assertions land there, and so does anything thrown later whose text is not a
 * create failure. Exported so that bucket is covered by a test -- it is the
 * branch nothing else exercises, being the one for failures nobody predicted.
 */
export function multiNodeFailurePhase(err: unknown): MultiNodeFailurePhase {
  if (err instanceof SandboxProvisionTerminalError) {
    return ["sandbox_workload_terminal", "sandbox_timed_out"].includes(err.reason)
      ? "terminal"
      : "wait";
  }
  return /create failed/i.test(String((err as Error)?.message ?? err)) ? "create" : "config";
}

export class SafeMultiNodeProvider implements MultiNodeProvider {
  readonly kind = "safe" as const;

  async ensure(
    sessionId: string,
    request: ExecuteRequest,
    onEvent: MultiNodeEventSink,
    opts?: MultiNodeEnsureOptions,
  ): Promise<MultiNodeContext> {
    const spec = resolveTopology(request);
    if (!spec) throw new Error("SafeMultiNodeProvider.ensure called for a single-node request");
    assertMultiNodeInferaModel(spec);

    const messageId = request.message_id?.trim();
    if (!messageId) throw new Error("multi-node request requires message_id");
    const namespace = request.workspace_id?.trim();
    if (!namespace) throw new Error("multi-node request requires workspace_id");
    const apiKey = (opts?.platformKey ?? request.platform_key ?? "").trim();
    if (!apiKey) throw new Error("multi-node request requires a SaFE platform key in safe mode");
    if (!SAFE_API_URL.trim()) throw new Error("SAFE_API_URL is not configured");
    // `--mn-image` wins; the sandbox image is the fallback so a prompt that
    // omits it keeps the previous "same image everywhere" behaviour.
    const image = spec.image || resolveSandboxImageFromRequest(request);
    if (!image) throw new Error("multi-node request requires image");
    const displayName = multiNodeWorkloadName(messageId, spec.backend);
    // Derived rather than random, so adopting a redelivered message's workload
    // reproduces the key its pods already trust (see sandbox/multi-node/ssh-key.ts).
    const keypair = spec.backend === "infera"
      ? deriveSessionKeypair(AUTH_INTERNAL_TOKEN, `${sessionId}:${messageId}`, `primus-claw-${sessionId}`)
      : null;

    // Kept outside the try so the catch can say whether there is a cluster,
    // rather than infer it: set once one exists, and only then.
    let workloadId: string | undefined;
    // And whether the create POST went out, which is not the same question: a
    // create can land without answering. Set where the request is issued rather
    // than here, so a body this deployment cannot build -- refused before
    // anything is sent -- does not name a cluster that was never asked for.
    const create = { posted: false };
    try {
      const adopted = await this.adoptExisting(sessionId, messageId, apiKey);
      workloadId = adopted
        ?? await this.createWorkload(
          sessionId, messageId, displayName, namespace, image, spec, apiKey, keypair, onEvent,
          normalizeWorkloadTimeout(request.timeout), create,
        );

      if (adopted) {
        logger.info({ sessionId, messageId, workloadId, backend: spec.backend }, "mn.safe_reuse_existing");
        await onEvent({
          type: "sandboxStatus",
          status: mnStatus(spec.backend, "reused"),
          ray_job_name: workloadId,
          workload_name: workloadId,
          namespace,
          mn_backend: spec.backend,
          delivery_count: opts?.deliveryCount,
        }).catch(() => {});
      }

      const detail = await this.waitForRunning(sessionId, workloadId, displayName, apiKey, namespace, spec, onEvent);

      logger.info({ sessionId, workloadId, backend: spec.backend }, "mn.safe_ready");
      await onEvent({
        type: "sandboxStatus",
        status: mnStatus(spec.backend, "ready"),
        ray_job_name: workloadId,
        workload_name: workloadId,
        namespace,
        mn_backend: spec.backend,
      }).catch(() => {});

      return await this.buildContext(
        workloadId, displayName, namespace, request, spec, detail, keypair,
      );
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const phase = multiNodeFailurePhase(err);
      // Empty only while no create was asked for, which is not the same as
      // having no id: a create can land without answering. A 2xx carrying no
      // workloadId, a conflict whose cleanup and retry both fail, a POST that
      // throws after the request arrived -- all three leave `workloadId` unset
      // with a cluster that may well be starting, and all three report `create`
      // above, so the phase does not separate them from a create that never
      // happened either.
      //
      // SaFE addresses these clusters by the message id: it is what
      // `adoptExisting` looks up and what `deleteWorkload` deletes. So the
      // message id names the cluster whether or not the create said so, and
      // naming nothing is what would leave one holding GPUs with no handle to
      // look it up by or delete it with.
      const workloadName = workloadId ?? (create.posted ? messageId : "");
      await onEvent({
        type: "sandboxStatus",
        status: mnStatus(spec.backend, "failed"),
        ray_job_name: workloadName,
        workload_name: workloadName,
        namespace,
        mn_backend: spec.backend,
        phase,
        message: msg.slice(0, 500),
        delivery_count: opts?.deliveryCount,
      }).catch(() => {});
      throw err;
    }
  }

  /**
   * Release only this message's cluster.
   *
   * The workload id IS the message id, so this addresses the cluster directly --
   * no lookup, and no way to touch the session's sandbox or another message's
   * cluster.
   */
  async releaseForMessage(
    sessionId: string,
    _namespace: string,
    messageId: string,
    opts?: MultiNodeEnsureOptions,
  ): Promise<void> {
    const key = (opts?.platformKey ?? "").trim();
    if (!key) {
      logger.warn({ sessionId, messageId }, "mn.safe_release_skipped_no_key");
      return;
    }
    await this.deleteWorkload(sessionId, messageId, key, "mn.safe_release");
  }

  /**
   * Tear down everything the session owns: its GPU clusters AND its Hands
   * sandbox. Deliberately session-scoped rather than message-scoped, so it also
   * reclaims a sandbox that destroyHands failed to stop, and any cluster whose
   * task died before it could release itself -- on session delete nothing
   * belonging to the session may outlive it.
   */
  async destroyForSession(
    sessionId: string,
    opts?: MultiNodeEnsureOptions,
  ): Promise<SessionDestroyResult> {
    const key = (opts?.platformKey ?? "").trim();
    if (!key) {
      // Without a key the session's clusters cannot even be listed, so this is
      // "unknown", not "none". Reported as incomplete so the caller can retry
      // with a key rather than assume the session is clean.
      logger.warn({ sessionId }, "mn.safe_session_destroy_skipped_no_key");
      return { complete: false, reason: "no_platform_key", found: 0, deleted: 0 };
    }
    let page: SessionWorkloadPage;
    try {
      page = await findSessionWorkloads(sessionId, key);
    } catch (e) {
      // Nothing was enumerated, so there is nothing to act on.
      logger.warn({ err: String(e), sessionId }, "mn.safe_lookup_failed");
      return { complete: false, reason: "lookup_failed", found: 0, deleted: 0 };
    }
    let found = 0;
    let deleted = 0;
    for (const ref of page.items) {
      // SaFE's list is database-backed, so it returns this session's finished
      // workloads too; deleting those would be pure noise.
      if (TERMINAL_PHASES.has(ref.phase)) continue;
      found += 1;
      if (await this.deleteWorkload(sessionId, ref.id, key, "mn.safe_session_destroy")) {
        deleted += 1;
      }
    }
    // Deleting everything on the page is not enough when the page was not the
    // whole set: the ones it never listed are still out there.
    const complete = deleted === found && !page.incomplete;
    logger.info(
      { sessionId, found, deleted, complete, truncated: page.incomplete },
      "mn.safe_session_destroy.done",
    );
    if (complete) return { complete, found, deleted };
    // A refused delete is the more actionable of the two, so it wins the label.
    const reason = deleted < found ? "delete_failed" : (page.reason ?? "lookup_failed");
    return { complete, reason, found, deleted };
  }

  /**
   * DELETE one workload by id. Returns whether SaFE took the removal on.
   *
   * Any 2xx counts: the deletion is SaFE's to finish from there, and 404 means
   * somebody already did. Anything else means the request did not land, so the
   * caller must not report a clean teardown — nothing else will come back for
   * this workload.
   */
  private async deleteWorkload(
    sessionId: string,
    workloadId: string,
    apiKey: string,
    logEvent: string,
  ): Promise<boolean> {
    const resp = await safeFetch(`/api/v1/workloads/${workloadId}`, { method: "DELETE", apiKey })
      .catch((e) => ({ status: 0, body: String(e) }));
    if ([200, 202, 204, 404].includes(resp.status)) {
      logger.info({ sessionId, workloadId, status: resp.status }, `${logEvent}.deleted`);
      return true;
    }
    logger.warn({ sessionId, workloadId, status: resp.status }, `${logEvent}.delete_failed`);
    return false;
  }

  /**
   * Adopt the workload a previous delivery of this message created, so a
   * redelivery reuses the cluster instead of doubling the GPU spend.
   *
   * A direct GET, because the workload id is the message id. This sees a cluster
   * still queueing for GPUs (the workload exists from creation, its backend CR
   * does not), and a workload already in a terminal phase is not adopted -- the
   * caller clears it so the id frees up.
   */
  private async adoptExisting(
    sessionId: string,
    messageId: string,
    apiKey: string,
  ): Promise<string | null> {
    const resp = await safeFetch(`/api/v1/workloads/${messageId}`, { apiKey }).catch((e) => {
      logger.warn({ err: String(e), sessionId, messageId }, "mn.safe_adopt_lookup_failed");
      return null;
    });
    if (!resp || resp.status === 404) return null;
    if (resp.status !== 200) {
      logger.warn({ sessionId, messageId, status: resp.status }, "mn.safe_adopt_lookup_failed");
      return null;
    }
    const phase = String((resp.body as Record<string, unknown>)?.phase ?? "").toLowerCase();
    if (TERMINAL_PHASES.has(phase)) {
      logger.info({ sessionId, workloadId: messageId, phase }, "mn.safe_adopt_skipped_terminal");
      return null;
    }
    return messageId;
  }

  /**
   * POST the CreateWorkloadRequest for the prompt's backend; returns the
   * workload id.
   *
   * `create.posted` is the caller's record of whether a request reached SaFE at
   * all, which it cannot get from the return value: the three ways this throws
   * after the POST lands are exactly the ways a cluster ends up existing under
   * a name nobody was told.
   */
  private async createWorkload(
    sessionId: string,
    messageId: string,
    displayName: string,
    namespace: string,
    image: string,
    spec: MultiNodePromptSpec,
    apiKey: string,
    keypair: SshKeypair | null,
    onEvent: MultiNodeEventSink,
    timeoutSec: number | undefined,
    create: { posted: boolean },
  ): Promise<string> {
    const common = {
      workspace: namespace,
      displayName,
      image,
      nodes: spec.nodes,
      gpusPerNode: spec.gpusPerNode,
      cpusPerNode: spec.cpusPerNode,
      memGiPerNode: spec.memPerNodeGiB,
      ephemeralGiPerNode: ephemeralGiPerNode(),
      sessionId,
      messageId,
      timeoutSec,
      defaultTimeoutSec: MULTI_NODE_DEFAULT_TIMEOUT_SECONDS,
      extraEnv: spec.extraEnv,
    };

    let body: Record<string, unknown>;
    if (spec.backend === "infera") {
      if (!keypair) throw new Error("infera workload requires a derived SSH keypair");
      body = buildInferaWorkloadBody({
        ...common,
        sshAuthorizedKey: keypair.authorizedKey,
        model: spec.model,
        framework: spec.framework,
        kvTransferBackend: spec.kvTransferBackend,
        pdMode: spec.pdMode,
        pdPrefillNodes: spec.pdPrefillNodes,
        pdDecodeNodes: spec.pdDecodeNodes,
        pdPrefillTp: spec.pdPrefillTp,
        pdDecodeTp: spec.pdDecodeTp,
      });
    } else {
      body = buildRayJobWorkloadBody(common);
    }

    logger.info({
      sessionId,
      messageId,
      displayName,
      namespace,
      backend: spec.backend,
      nodes: spec.nodes,
      image,
      pdMode: spec.pdMode,
    }, "mn.safe_creating");
    await onEvent({
      type: "sandboxStatus",
      status: mnStatus(spec.backend, "creating"),
      ray_job_name: displayName,
      workload_name: displayName,
      namespace,
      mn_backend: spec.backend,
      nodes: spec.nodes,
    }).catch(() => {});

    create.posted = true;
    let resp = await safeFetch("/api/v1/workloads", { method: "POST", apiKey, body });
    if (resp.status === 409) {
      // The workload id is the message id, so a conflict means a previous
      // delivery already created this cluster.
      const existing = await this.adoptExisting(sessionId, messageId, apiKey);
      if (existing) {
        logger.info({ sessionId, messageId, workloadId: existing }, "mn.safe_create_conflict_adopted");
        return existing;
      }
      // Nothing adoptable, so the conflicting workload is in a terminal phase.
      // Without clearing it the id stays taken and every redelivery of this
      // message would fail on the same 409 forever.
      logger.info({ sessionId, messageId }, "mn.safe_create_conflict_clearing_terminal");
      await this.deleteWorkload(sessionId, messageId, apiKey, "mn.safe_create_conflict")
        .catch((e) => logger.warn({ err: String(e), sessionId, messageId }, "mn.safe_conflict_cleanup_failed"));
      resp = await safeFetch("/api/v1/workloads", { method: "POST", apiKey, body });
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`multi-node workload create failed: HTTP ${resp.status} ${JSON.stringify(resp.body).slice(0, 300)}`);
    }
    const workloadId = String((resp.body as Record<string, unknown>)?.workloadId ?? "");
    if (!workloadId) {
      throw new Error(`multi-node workload create failed: no workloadId in ${JSON.stringify(resp.body).slice(0, 200)}`);
    }
    logger.info({ sessionId, messageId, workloadId, backend: spec.backend }, "mn.safe_created");
    return workloadId;
  }

  /**
   * Wait until the cluster is usable.
   *
   * The rules are waitForWorkloadReady's, shared with the single-node sandbox
   * path: the same poll rhythm, the same reading of a status, and the same three
   * backstops -- an unreadable status, a workload that has gone, and a queue
   * ceiling. This loop had only the ceiling, so a SaFE that stopped answering,
   * kept refusing, or answered without a phase left a GPU cluster being polled
   * with no way out.
   *
   * What is this path's own is what ready means and what a give-up costs. Infera
   * needs live role pod IPs, not just a phase, because external mode addresses
   * the pods directly over SSH. And a cluster that is given up on is DELETEd
   * rather than left: it holds GPUs, and DELETE is this path's teardown
   * primitive.
   */
  // Not private, and takes the wait's seams: what is worth testing here is the
  // wiring rather than the rules -- that Infera's readiness is asked with this
  // topology's pdMode and port base, and that giving up reaps this workload --
  // and reaching it through ensure() would mean a test paying a real poll
  // interval per case.
  async waitForRunning(
    sessionId: string,
    workloadId: string,
    displayName: string,
    apiKey: string,
    namespace: string,
    spec: MultiNodePromptSpec,
    onEvent: MultiNodeEventSink,
    deps?: WorkloadWaitDeps,
  ): Promise<Record<string, unknown>> {
    return await waitForWorkloadReady({
      workloadId,
      apiKey,
      logPrefix: "mn.safe",
      isReady: (detail) => {
        if (String(detail.phase ?? "").toLowerCase() !== "running") return false;
        if (spec.backend !== "infera") return true;
        return gpuPodsReady(
          discoverRolePods(detail, spec.pdMode, inferaSshPortBase(displayName)),
          spec.pdMode,
        );
      },
      onGiveUp: async ({ reason }) => {
        // Every give-up, not just the queue ceiling: a cluster nobody is waiting
        // on any more must not go on holding GPUs, whichever way the wait ended.
        // 404-tolerant, so giving up because the workload is gone is not itself
        // an error here.
        await this.deleteWorkload(sessionId, workloadId, apiKey, `mn.safe_${reason}`)
          .catch((e) => logger.warn({ err: String(e), sessionId, workloadId, reason }, "mn.safe_give_up_delete_failed"));
      },
      onProgress: async () => {
        await onEvent({
          type: "sandboxStatus",
          status: mnStatus(spec.backend, "provisioning"),
          message: `waiting for multi-node workload ${workloadId}`,
          ray_job_name: workloadId,
          workload_name: workloadId,
          namespace,
          mn_backend: spec.backend,
        }).catch(() => {});
      },
      deps,
    });
  }

  /**
   * Host serving the Ray control plane (Dashboard :8265 for job submit, GCS
   * :6379 for the derived ray_address).
   *
   * NOT the workload's own Service: SaFE exposes exactly one port there (8888,
   * the inference server), so a request to :8265 on it is refused. KubeRay's
   * `<rayClusterName>-head-svc` publishes the control-plane ports, and the
   * cluster name carries a generated suffix -- read back off the head pod name
   * (see sandbox/multi-node/safe-pods.ts rayClusterName). Falls back to the head pod's IP, which
   * serves every port directly but does not survive a head restart.
   */
  private resolveRayHeadHost(
    workloadId: string,
    namespace: string,
    detail: Record<string, unknown>,
  ): string | undefined {
    const clusterName = rayClusterName(detail);
    if (clusterName) return `${clusterName}-head-svc.${namespace}.svc.cluster.local`;
    const headIp = headPodIp(detail);
    if (headIp) {
      logger.info({ workloadId, headIp }, "mn.safe_head_host_pod_ip_fallback");
      return headIp;
    }
    logger.warn({ workloadId }, "mn.safe_head_host_unresolved");
    return undefined;
  }

  /** Assemble what the sandbox needs to drive the freshly provisioned cluster. */
  private async buildContext(
    workloadId: string,
    displayName: string,
    namespace: string,
    request: ExecuteRequest,
    spec: MultiNodePromptSpec,
    detail: Record<string, unknown>,
    keypair: SshKeypair | null,
  ): Promise<MultiNodeContext> {
    const host = `${workloadId}.${namespace}.svc.cluster.local`;
    const base: MultiNodeContext = {
      backend: spec.backend,
      provider: "safe",
      name: workloadId,
      namespace,
      nodeCount: spec.nodes,
      serviceUrl: "",
    };

    if (spec.backend === "rayjob") {
      return {
        ...base,
        serviceUrl: `http://${host}:${RAYJOB_SERVER_PORT}`,
        headHost: this.resolveRayHeadHost(workloadId, namespace, detail),
      };
    }

    const sshPortBase = inferaSshPortBase(displayName);
    const groups: RolePodGroups = discoverRolePods(detail, spec.pdMode, sshPortBase);
    return {
      ...base,
      serviceUrl: `http://${host}:${inferaFrontendPort(displayName)}`,
      sshPrivateKey: keypair?.privateKeyPem,
      sshKeyPath: SANDBOX_SSH_KEY_PATH,
      sshPortBase,
      prefillIps: groups.prefill.map((p) => p.podIp),
      decodeIps: groups.decode.map((p) => p.podIp),
      workerIps: groups.worker.map((p) => p.podIp),
    };
  }
}
