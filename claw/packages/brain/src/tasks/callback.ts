// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain → Backend lifecycle callbacks (task-design.md §11.2).
 *
 * For mode=script / mode=llm tasks dispatched through the new Task DAG
 * system, Brain reports completion (success / failure / cancellation /
 * wait_external) by POSTing an AgentDone payload to the URL the dispatcher
 * embedded on the `ExecuteRequest.callback_url` field.
 *
 * The legacy chat path (no `task_id`) is unaffected.
 */
import type {
  ExecuteRequest, ExecuteResult, RunPhase, RunWaitReason,
} from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "task-callback" });

export class AgentDoneDeliveryError extends Error {
  override readonly name = "AgentDoneDeliveryError";
}

interface AgentDoneBody {
  task_id?: string;
  final_text?: string;
  captures?: Record<string, string>;
  artifacts?: Array<Record<string, unknown>>;
  token_usage?: Record<string, unknown>;
  turns?: number;
  tool_stats?: Record<string, unknown>;
  error_count?: number;
  abort_reason?: string;
  failure_reason?: string;
  metadata?: Record<string, unknown>;
  /**
   * What the platform did, when it was the platform that ended the run. Only
   * sent when a read produced something: `applyAgentDone` writes each field it
   * receives, so sending empties would stamp over a reason a previous attempt
   * managed to read.
   */
  platform_message?: string;
  platform_node?: string;
  platform_exit_code?: number;
  platform_container_reason?: string;
}

/**
 * Who is running a task and what sandbox it got.
 *
 * Both are only knowable here: the row is written by the dispatcher, which
 * chooses no pod (JetStream does) and provisions no sandbox (this process
 * does, moments before the run starts).
 */
export interface RunOwnership {
  /** Which brain the run landed on. `BRAIN_ID` at the call site. */
  brainId?: string;
  /** The Hands workload serving it, as named by the sandbox provider. */
  sandboxWorkloadId?: string;
}

/**
 * Tell Backend the run has started executing, so its row can leave `preparing`.
 *
 * The dispatcher moves a row to `preparing` when it publishes the execution
 * message, and until now nothing moved it any further: rows sat in `preparing`
 * for their entire life and reached a terminal state directly from there. That
 * made `running` unreachable, which is not only wrong for anyone counting
 * concurrency but changes behaviour -- `cancelTask` decides between stopping a
 * run gracefully and closing the row outright by asking whether it is running.
 *
 * Deliberately best-effort, unlike `agent_done`. This reports a fact rather
 * than handing over responsibility: if it does not arrive the run still
 * executes and still reports its terminal state, and the row is merely
 * described less precisely in the meantime. Failing a run over an unsent
 * status update would trade a reporting problem for an execution one.
 */
export async function postTaskRunning(
  request: ExecuteRequest,
  ownership: RunOwnership = {},
): Promise<void> {
  if (!request.task_id || !request.callback_url) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (request.backend_internal_token) {
    headers["Authorization"] = `Bearer ${request.backend_internal_token}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const resp = await fetch(`${request.callback_url}/event`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task_id: request.task_id,
        type: "statusUpdate",
        agent_status: "running",
        // Ownership travels with the running signal rather than on its own
        // call because this is the first moment both facts exist, and a run
        // that never reports running has no sandbox to attribute anyway.
        brain_id: ownership.brainId || undefined,
        sandbox_workload_id: ownership.sandboxWorkloadId || undefined,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn(
        { taskId: request.task_id, status: resp.status },
        "task.running_signal_rejected",
      );
    }
  } catch (error) {
    logger.warn(
      { taskId: request.task_id, err: error instanceof Error ? error.message : String(error) },
      "task.running_signal_failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** What a lease renewal tells the row, beyond "the worker is still here". */
export interface LeaseRenewal {
  brainId: string;
  /** How long the row should consider the lease valid from now. */
  leaseSeconds: number;
  phase: RunPhase;
  waitReason?: RunWaitReason;
  /** Cumulative wall-clock the run has spent waiting rather than executing. */
  waitedMs: number;
  waits: number;
}

/**
 * The two ways a renewal can be refused, which ask opposite things of the run.
 *
 * `superseded` is another worker holding this run. Its sandbox, its workspace
 * and its copy of this delivery are that worker's now, and this one has to
 * stand down without touching any of them. `gone` is a row that is terminal or
 * missing, where nobody holds anything: this worker is the only one that can
 * release the sandbox it registered and settle the delivery it is holding, and
 * leaving them means a pinned workload and a message that comes back every
 * ack_wait to abort again.
 */
export type LeaseRefused = "gone" | "superseded";

/**
 * Which refusal a 409 was, defaulting to the one that touches nothing.
 *
 * An API too old to say -- the window of a rolling upgrade -- reads as
 * `superseded`, because the two mistakes are not the same size. Standing down
 * on a terminal row costs what it cost before this distinction existed: a
 * pinned sandbox until the idle collector, and a delivery that bounces until
 * its budget runs out. Giving a live worker's sandbox and message away costs
 * that worker's turn.
 */
async function readRefusal(resp: Response): Promise<LeaseRefused> {
  const body = (await resp.json().catch(() => null)) as { reason?: string } | null;
  return body?.reason === "terminal" || body?.reason === "missing" ? "gone" : "superseded";
}

/**
 * Renew this run's lease.
 *
 * The row is the authoritative answer to whether a run is alive, and until now
 * nothing wrote that answer: liveness was inferred from whether a queue
 * message was still unacknowledged, which conflates a dead worker with a slow
 * one and takes the redelivery budget — an hour and a half — to conclude
 * anything at all. A lease renewed every few seconds makes the same question
 * answerable in seconds, from a table anyone can query.
 *
 * Best-effort per call and deliberately quiet: a renewal that fails is not a
 * reason to stop a run that is otherwise fine, and the next tick is a few
 * seconds away. Enough consecutive failures and the lease expires, which is
 * the correct conclusion when a worker cannot reach the API at all.
 *
 * @returns the row's status when the API reported one, so a caller can notice
 *          a run that has been cancelled or reclaimed out from under it, or
 *          one of the two refusals below.
 */
export async function postRunLease(
  request: ExecuteRequest,
  renewal: LeaseRenewal,
): Promise<string | LeaseRefused | null> {
  const lease = request.run_lease;
  if (!lease?.url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const resp = await fetch(lease.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(lease.token ? { Authorization: `Bearer ${lease.token}` } : {}),
      },
      body: JSON.stringify({
        brain_id: renewal.brainId,
        lease_seconds: renewal.leaseSeconds,
        phase: renewal.phase,
        wait_reason: renewal.waitReason,
        waited_ms: renewal.waitedMs,
        waits: renewal.waits,
      }),
      signal: controller.signal,
    });
    // 409 is the one rejection that means something: this worker is not the
    // one the row recognises. Any other failure is just a failure, and a worker
    // must not stand down because the API had a bad moment.
    if (resp.status === 409) return await readRefusal(resp);
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "run.lease_renew_rejected");
      return null;
    }
    const body = (await resp.json().catch(() => null)) as { status?: string } | null;
    return body?.status ?? null;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "run.lease_renew_failed",
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST `<callback_url>/agent_done` with bounded retries. The callback is the
 * durable handoff that moves the Backend row to a terminal state, so exhausted
 * failures are thrown and the JetStream execution message remains unacked.
 * Backend transitions are CAS/idempotent, making callback retries safe.
 */
/**
 * Ceiling on the run's own text in the callback body.
 *
 * Captures are bounded where they are produced, because that is where the step
 * that produced one can be named. `final_text` is not: on the script path it is
 * the last step's whole stdout, which Hands will hand over up to 10 MiB of --
 * comfortably past the 4 MiB the API accepts. An oversized body fails the
 * callback, and a failed callback records a run that finished its work as never
 * having reported at all, losing everything else in the body with it.
 */
const MAX_FINAL_TEXT_BYTES = 256 * 1024;

/**
 * Cap for a downgraded body's failure_reason.
 *
 * Far smaller than the final-text cap on purpose: the downgrade exists because
 * the full body was already refused, so what survives it has to be small
 * enough that the second attempt cannot fail the same way.
 */
const MAX_DOWNGRADED_REASON_BYTES = 8 * 1024;

function truncate(text: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${head}\n[${label} truncated at ${maxBytes} bytes]`;
}

function truncateFinalText(text: string): string {
  return truncate(text, MAX_FINAL_TEXT_BYTES, "final text");
}

/**
 * The body with everything optional taken out of it.
 *
 * Used once, after a 413, and only because the alternative is worse: the
 * previous behaviour retried the identical body three times, threw, left the
 * JetStream message unacked, and failed the same way on every redelivery --
 * forever, for a run that had done its work. A row that lands carrying the
 * outcome and none of the output is a far smaller loss than a row that never
 * lands.
 */
function withoutPayload(body: AgentDoneBody): AgentDoneBody {
  return {
    ...body,
    final_text: "[dropped: the callback body exceeded the size the API accepts]",
    // failure_reason survived the downgrade, and on the script path it carries
    // a failing step's entire tool output -- uncapped. A multi-MiB stderr made
    // it the dominant field, so the shed body was still over the limit, all
    // three attempts 413'd, the JetStream message never acked, and every
    // redelivery failed identically. A downgrade that can still be too large
    // is not a downgrade.
    failure_reason: body.failure_reason
      ? truncate(body.failure_reason, MAX_DOWNGRADED_REASON_BYTES, "failure reason")
      : body.failure_reason,
    captures: {},
    artifacts: [],
    tool_stats: undefined,
  };
}

/** The platform half of the body, present only when there is something to say. */
function platformFields(result: ExecuteResult): Partial<AgentDoneBody> {
  const f = result.platformFacts;
  if (!f) return {};
  return {
    ...(f.message ? { platform_message: f.message } : {}),
    ...(f.node ? { platform_node: f.node } : {}),
    ...(f.containerReason ? { platform_container_reason: f.containerReason } : {}),
    ...(typeof f.exitCode === "number" ? { platform_exit_code: f.exitCode } : {}),
  };
}

export async function postAgentDone(
  request: ExecuteRequest,
  result: ExecuteResult,
): Promise<void> {
  if (!request.task_id || !request.callback_url) return;
  const url = `${request.callback_url}/agent_done`;
  const body: AgentDoneBody = {
    task_id: request.task_id,
    final_text: truncateFinalText(result.finalText ?? ""),
    captures: result.captures,
    artifacts: (result.artifacts ?? []) as unknown as Array<Record<string, unknown>>,
    token_usage: result.tokenUsage as unknown as Record<string, unknown>,
    turns: result.turns,
    tool_stats: result.toolStats as unknown as Record<string, unknown>,
    error_count: result.errorCount,
    abort_reason: result.abortReason ?? "completed",
    failure_reason: result.failureReason,
    metadata: result.waitExternalId ? { external_id: result.waitExternalId } : undefined,
    ...platformFields(result),
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (request.backend_internal_token) {
    headers["Authorization"] = `Bearer ${request.backend_internal_token}`;
  }
  let lastError: Error | undefined;
  let payload = body;
  let shed = false;
  let maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (resp.ok) return;
      // 413 is the one status a retry cannot help with: the body is too large
      // and will be exactly as large next time. Shed it once and retry that,
      // rather than spending the remaining attempts proving the point.
      if (resp.status === 413 && !shed) {
        shed = true;
        payload = withoutPayload(body);
        // Ordinary failures get three attempts. If the first size answer only
        // arrives on the third, grant the newly-built lean payload one distinct
        // send rather than constructing it and immediately leaving the loop.
        if (attempt === maxAttempts) maxAttempts++;
        logger.warn({ taskId: request.task_id }, "agent_done.body_shed_after_413");
      }
      lastError = new Error(`agent_done callback returned HTTP ${resp.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
    logger.warn(
      { taskId: request.task_id, attempt, err: lastError.message },
      "agent_done.retry",
    );
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new AgentDoneDeliveryError(lastError?.message ?? "agent_done callback failed");
}
