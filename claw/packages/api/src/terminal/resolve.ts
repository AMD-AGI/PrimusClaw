// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a session's shell is, and whether it can be connected to.
 *
 * A session's sandbox is an ordinary SaFE workload that carries the session id
 * in its environment, so it is found, and reached, through SaFE's generic
 * workload and webshell APIs; nothing here is Claw-specific on the SaFE side.
 * The registry binding Brain wrote when it provisioned the sandbox names the
 * workload directly and is used first. Only when there is none -- or the one on
 * record is gone -- is SaFE asked which workload carries the session.
 *
 * Every SaFE call is made with the caller's own SaFE key, so what the caller may
 * see is what SaFE says they may see, and nothing is read with a shared identity.
 */
import type { ShellTarget } from "./tickets.js";

const CALL_TIMEOUT_MS = 10_000;
const MAX_DETAIL_CHARS = 300;
const ENDED_PHASES = new Set(["Stopped", "Failed", "Succeeded"]);

/** The environment key that ties a SaFE workload to the session it serves. */
export const SESSION_ENV_KEY = "CLAW_SESSION_ID";

export type TerminalResolution =
  | { state: "ready"; target: ShellTarget }
  | { state: "none" | "starting" | "ended"; message: string };

/** The sandbox binding Brain recorded for the session, as far as this module reads it. */
export interface SandboxBinding {
  provider: "safe-workload" | "agent-sandbox";
  workloadId: string;
}

/**
 * SaFE could not be asked, or refused to answer.
 *
 * `unreachable` is a dependency that is down (the caller should retry);
 * `refused` is one that answered no (the key, or the permission, is the problem).
 */
export class TerminalUpstreamError extends Error {
  constructor(public readonly kind: "unreachable" | "refused", public readonly reason: string) {
    super(reason);
    this.name = "TerminalUpstreamError";
  }
}

interface WorkloadSummary {
  workloadId: string;
  workspaceId: string;
  phase: string;
  message?: string;
  creationTime?: string;
  userId?: string;
  pods?: { podId: string; phase: string }[];
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface ResolveInput {
  /** `SAFE_API_URL`: the API's base, without a trailing slash. */
  safeApiUrl: string;
  sessionId: string;
  /** The caller, so a workload found by environment is only taken if it is theirs. */
  userId: string;
  /** The caller's SaFE key. */
  apiKey: string;
  binding: SandboxBinding | null;
  fetchImpl?: FetchLike;
}

function clean(text: unknown): string {
  if (typeof text !== "string") return "";
  // Control characters out, length capped: this text is SaFE's, and goes to the browser.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
}

async function safeJson(
  input: ResolveInput,
  path: string,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: unknown }> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${input.safeApiUrl}${path}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new TerminalUpstreamError("unreachable", "cannot reach SaFE to look up the session's sandbox");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new TerminalUpstreamError("refused", `SaFE refused the caller's credentials (HTTP ${resp.status})`);
  }
  if (resp.status === 404) return { status: 404, body: null };
  if (!resp.ok) {
    throw new TerminalUpstreamError("unreachable", `SaFE answered HTTP ${resp.status} to the sandbox lookup`);
  }
  try {
    return { status: resp.status, body: await resp.json() };
  } catch {
    throw new TerminalUpstreamError("unreachable", "SaFE answered a sandbox lookup with a body that is not JSON");
  }
}

function asWorkload(body: unknown): WorkloadSummary | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.workloadId !== "string" || !b.workloadId) return null;
  const pods = Array.isArray(b.pods)
    ? b.pods.flatMap((p): { podId: string; phase: string }[] => {
      const o = p as Record<string, unknown> | null;
      return o && typeof o.podId === "string" && o.podId
        ? [{ podId: o.podId, phase: typeof o.phase === "string" ? o.phase : "" }]
        : [];
    })
    : undefined;
  return {
    workloadId: b.workloadId,
    workspaceId: typeof b.workspaceId === "string" ? b.workspaceId : "",
    phase: typeof b.phase === "string" ? b.phase : "",
    message: typeof b.message === "string" ? b.message : undefined,
    creationTime: typeof b.creationTime === "string" ? b.creationTime : undefined,
    userId: typeof b.userId === "string" ? b.userId : undefined,
    pods,
  };
}

function newest(workloads: WorkloadSummary[]): WorkloadSummary | undefined {
  return [...workloads].sort((a, b) => (b.creationTime || "").localeCompare(a.creationTime || ""))[0];
}

/**
 * The sandbox of one session: a running one if there is one, otherwise the
 * newest, so the answer can say why there is nothing to connect to.
 */
export function pickSessionSandbox(workloads: WorkloadSummary[]): WorkloadSummary | undefined {
  return newest(workloads.filter((w) => w.phase === "Running")) || newest(workloads);
}

export function describeUnavailable(workload: WorkloadSummary | undefined): TerminalResolution {
  if (!workload) {
    return {
      state: "none",
      message:
        "This session has no sandbox yet. A sandbox starts the first time the agent runs a command, and is released when idle.",
    };
  }
  const detail = clean(workload.message);
  const suffix = detail ? ` ${detail}` : "";
  if (ENDED_PHASES.has(workload.phase)) {
    return {
      state: "ended",
      message: `The sandbox of this session has ended (${clean(workload.phase)}). A new one starts the next time the agent runs a command.${suffix}`,
    };
  }
  return {
    state: "starting",
    message: `The sandbox is not running yet (${clean(workload.phase) || "unknown phase"}). Try again once it is up.${suffix}`,
  };
}

async function findByEnvironment(input: ResolveInput, fetchImpl: FetchLike): Promise<WorkloadSummary | undefined> {
  const qs = new URLSearchParams({ envKey: SESSION_ENV_KEY, envValue: input.sessionId, limit: "20" });
  const { body } = await safeJson(input, `/api/v1/workloads?${qs.toString()}`, fetchImpl);
  const items = body && typeof body === "object" ? (body as { items?: unknown }).items : undefined;
  const found = (Array.isArray(items) ? items : [])
    .map(asWorkload)
    .filter((w): w is WorkloadSummary => w !== null)
    // Whatever SaFE lists for the caller, only the caller's own workload is
    // theirs to open a shell in: an operator key lists everyone's.
    .filter((w) => w.userId === undefined || w.userId === input.userId);
  return pickSessionSandbox(found);
}

/** The state of a session's terminal, and where it is when it is ready. */
export async function resolveTerminal(input: ResolveInput): Promise<TerminalResolution> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const enc = encodeURIComponent;

  // An agent-sandbox has no SaFE workload, and so no SaFE webshell.
  if (input.binding?.provider === "agent-sandbox") {
    return {
      state: "none",
      message: "The sandbox of this session does not provide a web terminal.",
    };
  }

  let workload: WorkloadSummary | undefined;
  if (input.binding) {
    const { body } = await safeJson(input, `/api/v1/workloads/${enc(input.binding.workloadId)}`, fetchImpl);
    // A binding whose workload SaFE no longer knows is stale, not an answer.
    workload = asWorkload(body) ?? undefined;
  }
  if (!workload) {
    const listed = await findByEnvironment(input, fetchImpl);
    if (!listed || listed.phase !== "Running") return describeUnavailable(listed);
    const { body } = await safeJson(input, `/api/v1/workloads/${enc(listed.workloadId)}`, fetchImpl);
    workload = asWorkload(body) ?? listed;
  }
  if (workload.phase !== "Running") return describeUnavailable(workload);

  const pod = (workload.pods || []).find((p) => p.phase === "Running");
  if (!pod) return describeUnavailable({ ...workload, phase: "Pending" });

  const { body } = await safeJson(
    input,
    `/api/v1/workloads/${enc(workload.workloadId)}/pods/${enc(pod.podId)}/containers`,
    fetchImpl,
  );
  const containers = body && typeof body === "object" ? (body as { containers?: unknown }).containers : undefined;
  const first = Array.isArray(containers) ? (containers[0] as { name?: unknown } | undefined) : undefined;
  const container = typeof first?.name === "string" ? first.name : "";
  if (!container) {
    return { state: "starting", message: "The sandbox pod reports no container yet. Try again in a moment." };
  }
  if (!workload.workspaceId) {
    throw new TerminalUpstreamError("unreachable", "SaFE did not say which workspace the sandbox is in");
  }
  return {
    state: "ready",
    target: { workloadId: workload.workloadId, workspaceId: workload.workspaceId, pod: pod.podId, container },
  };
}
