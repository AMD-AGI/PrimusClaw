// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Data-plane liveness of a Hands sandbox, independent of the MCP port.
 *
 * Hands 9100 going dark is not the same as the container being gone: a
 * codeinterpreter crash or an NFS flush stall can drop MCP while `exec` still
 * succeeds. Rebuild used to treat the former as the latter and SIGTERM the
 * workload. Callers that are about to destroy a sandbox must check this first.
 *
 * Three-valued rather than boolean, because "nobody could be asked" is a third
 * thing and the two mistakes it used to be folded into are opposite. Answering
 * `dead` when the control plane is merely unreachable destroys a live container
 * with a Hyperloom job in it; answering `alive` there leaves a genuinely dead
 * sandbox unrepaired forever. Only `dead` licenses a destroy, and only `alive`
 * licenses leaving things alone; `unknown` means try again rather than act.
 *
 * Every path also names itself. Operationally "the probe said no" is useless:
 * a missing KV entry, a Router 500 and a container that ran `true` and returned
 * 1 call for three different responses, and until now three of the four paths
 * were silent.
 */
import { StringCodec } from "nats";
import { isTombstone } from "../tasks/lock.js";
import pino from "pino";
import { AGENT_SANDBOX_NAMESPACE, SANDBOX_NAMESPACE } from "../config.js";
import { metrics } from "../infra/metrics.js";
import { getHandsKv } from "./registry.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import type { SandboxExecResult, SandboxInstance } from "./provider.js";

const logger = pino({ name: "sandbox-container-probe" });
const sc = StringCodec();

/** Short enough not to delay a genuine rebuild; long enough for a healthy exec. */
const PROBE_COMMAND = "true";
const PROBE_TIMEOUT = "5s";

/**
 * Ceiling on the whole probe, over and above the cap each provider puts on its
 * own HTTP call.
 *
 * The provider's cap is sized for the command (its deadline plus transport
 * slack), which is the right bound for a caller that wants the command's
 * result. This caller does not: it is on the tool-batch path deciding whether
 * to rebuild, and it would rather assume `unknown` quickly than learn `alive`
 * twenty seconds later with the agent loop stopped the whole time.
 */
const PROBE_DEADLINE_MS = 8_000;

/**
 * What the data plane was able to say about the container.
 *
 *   alive   — a command ran inside it just now.
 *   dead    — explicit evidence says it is gone or cannot run `true`.
 *   unknown — nobody could be reached to ask. Destroy paths must not act.
 */
export type ContainerProbeVerdict = "alive" | "dead" | "unknown";

/**
 * Why the probe answered as it did. A closed set because it is a metric label;
 * see the discipline note in infra/metrics.ts.
 */
export type ContainerProbeReason =
  | "exec_ok"
  | "exec_nonzero"
  | "exec_no_exit_code"
  | "exec_sandbox_gone"
  | "exec_unreachable"
  | "exec_deadline"
  | "kv_unreachable"
  | "no_kv_entry"
  | "entry_unusable"
  | "entry_corrupt"
  | "aborted";

/** KV answered with bytes that were not JSON. Distinct from an empty key. */
export const HANDS_ENTRY_CORRUPT = "hands_entry_corrupt";

export interface ContainerProbeOutcome {
  verdict: ContainerProbeVerdict;
  reason: ContainerProbeReason;
}

export interface HandsProbeEntry {
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;
  platformKey?: string;
  token?: string;
  sessionId?: string;
  sandboxName?: string;
  namespace?: string;
  userId?: string;
}

export interface ContainerProbeEffects {
  readHandsEntry: (sessionId: string) => Promise<HandsProbeEntry | null>;
  exec: (
    inst: SandboxInstance,
    command: string,
    timeout: string,
    signal?: AbortSignal,
  ) => Promise<SandboxExecResult>;
}

/**
 * Throws when KV itself could not be read or its payload was not JSON, and
 * returns null when KV answered and holds nothing. The caller turns an
 * unreachable bucket and a corrupt payload into `unknown`, and an empty key
 * into `dead`. Swallowing a parse failure used to license destroying a live
 * sandbox the same way an unreachable KV did.
 */
async function defaultReadHandsEntry(sessionId: string): Promise<HandsProbeEntry | null> {
  const entry = await getHandsKv().get(`hands.${sessionId}`);
  // A delete leaves a readable entry with an empty value. Letting it reach the
  // parser turns "the entry is gone" into `entry_corrupt`, and the two answers
  // point opposite ways: corrupt means unknown, which tells the caller to leave
  // the container alone, so a sandbox whose entry was deleted is never rebuilt
  // and every attempt spends another recovery. Absent is the answer that fits
  // the fact, and it is the one the comment below is written about.
  if (!entry || isTombstone(entry)) return null;
  return parseHandsProbeValue(sc.decode(entry.value));
}

/**
 * Bytes from `hands.<sessionId>` as an identity. Throws HANDS_ENTRY_CORRUPT
 * rather than returning null: a corrupt payload is not "there is no sandbox",
 * and folding the two licensed destroying a live container.
 */
export function parseHandsProbeValue(raw: string): HandsProbeEntry {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(HANDS_ENTRY_CORRUPT);
    }
    return value as HandsProbeEntry;
  } catch {
    throw new Error(HANDS_ENTRY_CORRUPT);
  }
}

async function defaultExec(
  inst: SandboxInstance,
  command: string,
  timeout: string,
  signal?: AbortSignal,
): Promise<SandboxExecResult> {
  const provider = inst.provider === "agent-sandbox"
    ? getAgentSandboxProvider()
    : getSafeWorkloadProvider();
  return provider.exec(inst, command, timeout, signal);
}

const realEffects: ContainerProbeEffects = {
  readHandsEntry: defaultReadHandsEntry,
  exec: defaultExec,
};

let effects: ContainerProbeEffects = realEffects;

/** Override probe I/O; returns the call that puts the real effects back. */
export function bindContainerProbeEffects(
  overrides: Partial<ContainerProbeEffects>,
): () => void {
  const prev = effects;
  effects = { ...effects, ...overrides };
  return () => { effects = prev; };
}

/**
 * The sandbox an entry names, in the shape the providers take.
 *
 * Exported because the recovery path has to reach the same container to restart
 * Hands inside it, and resolving the identity a second time from the same
 * fields is how the probe and the repair would come to disagree about which
 * sandbox they are talking about.
 */
export function instanceFromEntry(
  sessionId: string,
  entry: HandsProbeEntry,
): SandboxInstance | null {
  if (entry.provider === "agent-sandbox") {
    const id = entry.sessionId || sessionId;
    // The namespace is part of the address, not a decoration: exec builds
    // `/v1/namespaces/<ns>/code-interpreters/<name>/...`, so an empty one asks
    // the Router about a path that cannot resolve, and the 404 that comes back
    // is read as `exec_sandbox_gone` -- a `dead` verdict, which is the one that
    // licenses a destroy. An entry we cannot address is `entry_unusable`, not
    // evidence about the container. The safe-workload branch below has always
    // had a fallback; this one silently used "".
    const namespace = entry.namespace || AGENT_SANDBOX_NAMESPACE;
    if (!id || !entry.sandboxName || !namespace) return null;
    return {
      provider: "agent-sandbox",
      id,
      sandboxName: entry.sandboxName,
      namespace,
      handsBaseUrl: "",
      userId: entry.userId,
    };
  }
  if (!entry.workloadId) return null;
  return {
    provider: "safe-workload",
    id: entry.workloadId,
    sandboxName: entry.workloadId,
    namespace: entry.namespace || SANDBOX_NAMESPACE,
    handsBaseUrl: "",
    platformKey: entry.platformKey,
  };
}

/**
 * Whether two identities name the same sandbox.
 *
 * DAG nodes share a session, so comparing session ids is not enough: the
 * workload (or agent-sandbox name) is what distinguishes siblings.
 */
export function sameHandsSandbox(
  a?: HandsProbeEntry | null,
  b?: HandsProbeEntry | null,
): boolean {
  if (!a || !b) return false;
  const aAgent = a.provider === "agent-sandbox";
  const bAgent = b.provider === "agent-sandbox";
  if (aAgent !== bAgent) return false;
  if (aAgent) {
    return !!(
      a.sessionId
      && a.sessionId === b.sessionId
      && a.sandboxName
      && a.sandboxName === b.sandboxName
      && (a.namespace || "") === (b.namespace || "")
    );
  }
  return !!(a.workloadId && a.workloadId === b.workloadId);
}

/** Run a command in the resolved sandbox, through the provider exec path. */
export function execInSandbox(
  inst: SandboxInstance,
  command: string,
  timeout: string,
  signal?: AbortSignal,
): Promise<SandboxExecResult> {
  return effects.exec(inst, command, timeout, signal);
}

/**
 * The session's recorded sandbox identity, through the same seam the probe
 * uses. Throws when KV could not be read, so a caller can tell that apart from
 * a session with nothing recorded.
 */
export function readHandsProbeEntry(sessionId: string): Promise<HandsProbeEntry | null> {
  return effects.readHandsEntry(sessionId);
}

/**
 * Statuses that say the sandbox is gone rather than unreachable:
 * `sandboxExec failed: HTTP 404 …` (safe-workload) and
 * `agent-sandbox exec failed: 404 …`.
 *
 * Anchored on where the provider puts the status, because both of them append
 * up to 300 characters of response body — a 500 whose body happens to mention
 * a 404 must not be read as proof the sandbox is gone, since that is what
 * licenses the destroy this path exists to withhold.
 *
 * That this mapping is safe rests on the Router answering 404 only for a
 * session it has no record of, and something else when it has one it cannot
 * reach. Verified against the live Router on 2026-08-21 by reproducing the
 * incident's state -- session registered, backing pod deleted so the Service
 * had no ready endpoint:
 *
 *   healthy                          -> 200
 *   pod deleted / not ready          -> 502 {"error":"upstream error: Post
 *                                      \"http://<svc>:8080/api/execute\":
 *                                      dial tcp: lookup <svc>: no such host"}
 *   session stopped / expired / new  -> 404 {"error":"session \"sess_…\" not
 *                                      found (may have expired or been
 *                                      deleted)…"}
 *
 * So the incident's own failure lands on 502 -> `exec_unreachable` -> `unknown`,
 * and nothing licenses a destroy. Re-run that check if the Router's error
 * mapping changes: a 404 for an unreachable backend would turn this function
 * into a rubber stamp for the destroy the module exists to prevent.
 */
function execFailureMeansGone(err: unknown): boolean {
  return /exec failed: (?:HTTP )?(?:404|410)\b/i.test(String((err as Error)?.message ?? err));
}

// Sentinels rather than message matching: these two are the only failures the
// classifier must tell apart from a provider error, and both are raised here.
const PROBE_DEADLINE_ERROR = "container_probe_deadline";
const PROBE_ABORTED_ERROR = "container_probe_aborted";

/** The probe exec, abandoned at PROBE_DEADLINE_MS or when the caller aborts. */
async function execWithDeadline(
  inst: SandboxInstance,
  signal?: AbortSignal,
): Promise<SandboxExecResult> {
  // Re-checked here, not only on the way in: resolving the sandbox's identity
  // is asynchronous, so an abort can land between that check and this one, and
  // an `addEventListener` after the fact would never hear it. That left the
  // probe waiting out its full deadline for a caller that had already gone.
  if (signal?.aborted) throw new Error(PROBE_ABORTED_ERROR);
  const controller = new AbortController();
  const call = effects.exec(inst, PROBE_COMMAND, PROBE_TIMEOUT, controller.signal);
  // The losing side of the race still settles. Claiming its rejection keeps a
  // slow failure arriving after the deadline from becoming an unhandled
  // rejection, which in Node takes the process down.
  call.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort(new Error(PROBE_DEADLINE_ERROR));
            reject(new Error(PROBE_DEADLINE_ERROR));
          },
          PROBE_DEADLINE_MS,
        );
        if (signal) {
          onAbort = () => {
            controller.abort(new Error(PROBE_ABORTED_ERROR));
            reject(new Error(PROBE_ABORTED_ERROR));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** The verdict, before it is logged or counted. */
async function classify(
  sessionId: string,
  known: HandsProbeEntry | undefined,
  signal: AbortSignal | undefined,
): Promise<ContainerProbeOutcome> {
  if (signal?.aborted) return { verdict: "unknown", reason: "aborted" };

  let entry: HandsProbeEntry | null;
  if (known) {
    entry = known;
  } else {
    try {
      entry = await effects.readHandsEntry(sessionId);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      return msg === HANDS_ENTRY_CORRUPT
        ? { verdict: "unknown", reason: "entry_corrupt" }
        : { verdict: "unknown", reason: "kv_unreachable" };
    }
  }
  // KV answered and named nothing: there is no container left to protect.
  // The one verdict here that is not evidence about the container. A missing
  // entry can also be a TTL expiry over a pod that is still up and still
  // running the user's work -- we simply have no way to address it any more.
  // Calling it dead is still right for what callers do next: without a
  // workloadId nothing destructive is possible, so the only move is to build
  // a new sandbox and leave the old one to the control plane's own GC. Worth
  // knowing that "never destroy a live container" holds everywhere except
  // here, and here it holds because there is nothing to destroy it with.
  if (!entry) return { verdict: "dead", reason: "no_kv_entry" };
  const inst = instanceFromEntry(sessionId, entry);
  if (!inst) return { verdict: "unknown", reason: "entry_unusable" };

  try {
    const result = await execWithDeadline(inst, signal);
    if (result.exitCode === 0) return { verdict: "alive", reason: "exec_ok" };
    // A negative code is what both providers substitute when the response
    // carried none at all, which is the control plane being odd rather than
    // evidence about the container. `true` exiting non-zero for real is not
    // something a working container does, but the response proves the control
    // plane still reached a container; it is not permission to destroy it.
    return result.exitCode < 0
      ? { verdict: "unknown", reason: "exec_no_exit_code" }
      : { verdict: "unknown", reason: "exec_nonzero" };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg === PROBE_ABORTED_ERROR) return { verdict: "unknown", reason: "aborted" };
    if (msg === PROBE_DEADLINE_ERROR) return { verdict: "unknown", reason: "exec_deadline" };
    if (execFailureMeansGone(err)) {
      return { verdict: "dead", reason: "exec_sandbox_gone" };
    }
    return { verdict: "unknown", reason: "exec_unreachable" };
  }
}

/**
 * Ask the sandbox container to run a command through the provider exec path
 * (SaFE data-plane / agent-sandbox execute), never through Hands MCP.
 *
 * `known` names the sandbox explicitly, for callers that already hold its
 * identity. Without it the identity comes from `hands.<sessionId>`, which every
 * node of a DAG shares -- so a node running against an inherited sandbox would
 * otherwise probe whichever sibling wrote that key last, and act on the answer.
 */
export async function probeSandboxContainer(
  sessionId: string,
  known?: HandsProbeEntry,
  signal?: AbortSignal,
): Promise<ContainerProbeOutcome> {
  const startedAt = Date.now();
  const outcome = await classify(sessionId, known, signal);
  const elapsedMs = Date.now() - startedAt;
  metrics.onSandboxContainerProbe(outcome.verdict, outcome.reason, elapsedMs / 1000);
  const line = {
    sessionId,
    verdict: outcome.verdict,
    reason: outcome.reason,
    elapsedMs,
    explicitIdentity: !!known,
  };
  // An `alive` verdict is the quiet, expected one; the other two are what an
  // operator is looking for when a session stops making progress.
  if (outcome.verdict === "alive") logger.info(line, "sandbox.container_probe");
  else logger.warn(line, "sandbox.container_probe");
  return outcome;
}
