// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { mintScopeCredential } from "@claw/utils";
import type { ReapReport, ReapedShell, ReclaimCause } from "@claw/protocol";
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import { metrics } from "../infra/metrics.js";
import {
  isShellAddressingCall, resolveStart, restorePublicShellId, restoreStructuredShellId,
  runQualifiedShellId, type RecordProbe,
} from "../sandbox/bg-start.js";
import {
  advanceRow, readRow, readRunRows, rowKey,
  type BgHandleAddress, type BgHandleRow, type BgRowStore,
} from "../sandbox/bg-handle-rows.js";

/** What a fixed start carries onto its row, so a replay can find it again. */
type StartCarry = Pick<
  BgHandleRow, "commandDigest" | "sequence" | "claimedBy" | "stepIdentity"
>;

/**
 * What identifies this call for a replay that has to recognise it again.
 *
 * The model-issued tool-use identifier in agent mode, the step's position in
 * script mode. It is sealed onto the reference row before the dispatch, which
 * is what makes it usable on resume -- the provider is free to hand back a
 * different one, and a call that does is a new call.
 */
export interface CallContext {
  stepIdentity?: string;
}
import { bgRowStore } from "../sandbox/bg-row-store.js";
import {
  BG_SHELL_ENABLED, BG_SHELL_REAP_GRACE_MS, BRAIN_CHECKPOINT_KEY, BRAIN_ID,
  HANDS_CALL_DEFAULT_TIMEOUT_MS, HANDS_CLOSE_TIMEOUT_MS,
} from "../config.js";
import {
  isSandboxTool, MCP_DEADLINE_SLACK_MS, toolTakesTimeout, toolTimeoutCeilingSec,
} from "../tools/hands.js";

const logger = pino({ name: "hands-client" });

/**
 * Shared undici Agent used for every Brain→Hands MCP request.
 *
 * The MCP SDK's `StreamableHTTPClientTransport` uses Node's built-in `fetch`
 * (undici under the hood). undici's defaults are `headersTimeout = 300_000`
 * and `bodyTimeout = 300_000`, both of which fire as `UND_ERR_HEADERS_TIMEOUT`
 * / `UND_ERR_BODY_TIMEOUT` after exactly 5 minutes — even though our own
 * MCP-level `callTool({ timeout })` allows up to an hour. A long-running bash
 * tool (e.g. `ka run`, 5–15 min) keeps the response stalled on the Hands side
 * until the child process exits, so no response headers arrive and undici
 * aborts the fetch at 5 min, leaving the LLM to recover blind.
 *
 * Zeroing both timeouts disables the transport-level cap; the MCP-level
 * timeout (`callDeadlineMs` below) remains the only deadline. Connection
 * health is still covered by `keepAliveTimeout` + TCP-level keep-alives.
 *
 * Module-level singleton so every HandsClient instance reuses the same
 * undici connection pool (one keep-alive pool per Brain pod).
 *
 * IMPORTANT — must be paired with the `undici` package's own `fetch`, NOT
 * Node's built-in global `fetch`. Node's built-in fetch is backed by Node's
 * *internal* undici (v6 on Node 22), whose per-request handler uses the legacy
 * `onConnect/onHeaders/onData` interface. This `Agent` comes from the
 * standalone `undici` package (v8), whose `assertRequestHandler` requires the
 * newer `onRequestStart/onResponseStart/...` interface. Dispatching a v6
 * handler through this v8 Agent throws `InvalidArgumentError: invalid
 * onRequestStart method` and every Brain→Hands request fails with
 * `fetch failed`. Passing `undiciFetch` (v8) to the transport keeps fetch and
 * dispatcher on the same undici so the handler interfaces match.
 */
const HANDS_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 4_000,
});

/**
 * Returns true when the given error indicates the Hands sandbox is unreachable
 * (Pod gone, port closed, connection reset). The agent loop uses this to
 * count consecutive sandbox-down events and trigger an in-flight workload
 * rebuild instead of letting the LLM burn turns on inevitable failures.
 *
 * MCP request timeout (-32001) is intentionally NOT classified as network
 * unreachable. It commonly means the tool itself exceeded its configured
 * timeout (for example a long `bash` command), while the sandbox may still be
 * healthy. Classify it with `isHandsToolTimeout` instead.
 *
 * Business-level errors (a `bash` command exiting non-zero, a missing file,
 * etc.) are NOT covered here — those still travel back to the LLM as normal
 * tool_result text.
 */
/**
 * Every code and phrase that counts as "the MCP call did not complete over the
 * network". One table, used both to classify an error and to name it, so the
 * two can never disagree about what a `UND_ERR_*` is.
 *
 * `UND_ERR_ABORTED` is left out on purpose: an aborted request is usually our
 * own cancellation, not the sandbox failing.
 */
const HANDS_NETWORK_ERROR_RE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|socket hang up|other side closed|premature close|fetch failed|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_CLOSED|UND_ERR_DESTROYED/i;

/** Message, code and errno of an error and its `cause` chain, as one string. */
function errorSignature(err: unknown): string {
  const e = err as any;
  const parts: string[] = [];
  for (const node of [e, e?.cause, e?.cause?.cause]) {
    if (node?.message) parts.push(String(node.message));
    if (node?.code) parts.push(String(node.code));
    if (node?.errno) parts.push(String(node.errno));
  }
  return parts.join(" | ");
}

export function isHandsNetworkError(err: unknown): boolean {
  if (!err) return false;
  // undici/fetch wraps DNS / connect errors in `cause`.
  return HANDS_NETWORK_ERROR_RE.test(errorSignature(err));
}

/** Best-effort code/phrase for a Hands network failure (`ECONNREFUSED`, `UND_ERR_SOCKET`, …). */
export function handsNetworkErrorReason(err: unknown): string {
  if (!err) return "unknown";
  const e = err as any;
  // A code on the error or its cause is the precise answer; the message is a
  // fallback for the wrappers that carry the phrase but drop the code.
  for (const node of [e, e?.cause, e?.cause?.cause]) {
    if (node?.code) return String(node.code);
    if (node?.errno) return String(node.errno);
  }
  const m = String(e?.message || err).match(HANDS_NETWORK_ERROR_RE);
  return m ? m[0] : "unknown";
}

/** Returns true when the MCP client reports a per-request tool timeout. */
export function isHandsToolTimeout(err: unknown): boolean {
  if (!err) return false;
  const e = err as any;
  const msg = String(e?.message || "");
  return e?.code === -32001 || /MCP error -32001|Request timed out/i.test(msg);
}

/** The text of a thrown thing, for a message the model reads. */
function errorText(err: unknown): string {
  return String((err as { message?: string })?.message ?? err);
}

/**
 * What a sandbox tool's own deadline passing means, and what to do about it.
 *
 * What arrived before was `Error: MCP error -32001: Request timed out`, which
 * names the JSON-RPC code for a deadline and nothing else -- not which
 * deadline, not whether the command is still running, not what to do
 * differently. The observed response was to run the same command again with a
 * larger `timeout`.
 *
 * That response is futile here, whatever the argument was. The deadline is the
 * timeout the tool would grant this call plus transport slack, and Hands
 * answers a command that reaches its timeout: `bash` times the command out at
 * the granted second and returns the output so far, and `wait` returns having
 * waited. So the RPC ends before this deadline whenever Hands is answering at
 * all, and reaching it points the other way -- Hands did not answer, because
 * the sandbox is gone, wedged, or stuck killing the process group. Points
 * rather than proves: the clamp that makes the argument hold lives in the
 * sandbox's own `BASH_MAX_TIMEOUT_SEC`, and one bootstrapped before that
 * number agreed with Brain's ceiling is still honouring a longer one. So this
 * reads as the likelier explanation rather than a finding -- and offers no
 * timeout argument either way, since none buys a way out of either case.
 *
 * Only the two tools with a ceiling of their own take a timeout at all. For the
 * rest -- `read`, `grep`, `ls`, `upload_to_s3` -- there is no granted timeout to
 * be past and no argument to raise, so the message says neither, and does not
 * offer the background-shell route to work that never named a duration.
 *
 * What it must not say is that the command was killed. Giving up on the call
 * cancels nothing in the sandbox: `bash` is handed a command and a timeout and
 * no cancellation channel, so the process may still be running there and still
 * writing to /workspace. A model told the process group was gone re-runs the
 * command, and the two copies then write over each other.
 *
 * Where to put work too long for one call depends on the deployment. With
 * background shells off, `run_in_background` is refused and the bash schema
 * says as much, so naming it here would send the model at a tool it cannot
 * call.
 */
function explainSandboxTimeout(toolName: string, args: Record<string, unknown>): string {
  const abandoned = `Error: \`${toolName}\` had not answered when this call's `
    + `${Math.round(callDeadlineMs(toolName, args) / 1000)}s deadline passed, `
    + `so the call was abandoned. Nothing was cancelled by that: the command may `
    + `still be running in the sandbox, so check what it has already done before `
    + `starting it again. `;
  if (!toolTakesTimeout(toolName)) {
    return abandoned
      + `\`${toolName}\` takes no timeout of its own, so there is no argument to `
      + `raise here; what a passed deadline leaves worth checking is whether the `
      + `sandbox is answering at all.`;
  }
  const alternative = BG_SHELL_ENABLED
    ? `For work that may take longer than the ceiling, start it with `
      + `bash(run_in_background=true) and then call wait, which can block far `
      + `longer because it holds nothing open.`
    : `This deployment has no background mode, so work that may take longer `
      + `than that has to be split into steps that each finish inside it.`;
  return abandoned
    + `That deadline is already past the timeout this call was granted, and a `
    + `command that reaches its own timeout comes back as a result rather than `
    + `as this, so a larger timeout argument is unlikely to be the repair; the `
    + `likelier reading is that the sandbox stopped answering, so check it is `
    + `still alive first. ${alternative}`;
}

/**
 * Turn a transport failure into something the model can act on.
 *
 * Which tool it is decides this before which failure it is. A tool the sandbox
 * does not run -- an `mcp__*` tool, `a2a_call` -- reaches a different server
 * over a different transport, and both failures here read as the same words
 * from the SDK. Told the sandbox story about one of those, the model goes
 * looking in /workspace for a process that was never there and waits out a
 * rebuild that would not fix anything.
 */
export function explainHandsError(
  err: unknown,
  toolName: string,
  args: Record<string, unknown> = {},
): string {
  const sandboxTool = isSandboxTool(toolName);
  if (isHandsToolTimeout(err)) {
    if (sandboxTool) return explainSandboxTimeout(toolName, args);
    return `Error: \`${toolName}\` did not answer before its transport's `
      + `request timeout, so the call was abandoned. Nothing in the call's `
      + `arguments moves that deadline. Whether the server finished the work is `
      + `not visible from here, so check its effect before repeating anything `
      + `that changes state.`;
  }
  if (isHandsNetworkError(err)) {
    const detail = errorText(err).slice(0, 200);
    if (sandboxTool) {
      return `Error: the sandbox running \`${toolName}\` is unreachable `
        + `(${detail}). It may be being rebuilt; the files in /workspace are `
        + `restored when it comes back.`;
    }
    return `Error: the server providing \`${toolName}\` could not be reached `
      + `(${detail}). It is not the sandbox -- nothing in /workspace is affected `
      + `and there is no rebuild to wait for -- so either retry the call or carry `
      + `on without this tool.`;
  }
  return `Error: ${errorText(err)}`;
}

/**
 * Whether the sandbox at this url files durable shell records.
 *
 * Its own function, and replaceable, because it is a live HTTP read that every
 * addressing decision depends on: a test that cannot choose which version it is
 * talking to cannot exercise either side of the boundary.
 */
async function probeShellRecordsCapability(url: string): Promise<boolean> {
  try {
    const resp = await undiciFetch(handsEndpoint(url, "/health"), {
      signal: AbortSignal.timeout(5_000),
      dispatcher: HANDS_DISPATCHER,
    } as Parameters<typeof undiciFetch>[1]);
    const body = resp.ok ? await resp.json() as { bgShellRecords?: unknown } : {};
    return body?.bgShellRecords === true;
  } catch {
    return false;
  }
}

let readShellRecordsCapability = probeShellRecordsCapability;

/** Swap the capability read; returns the call that puts the real one back. */
export function bindShellRecordsCapabilityForTest(
  fn: (url: string) => Promise<boolean>,
): () => void {
  readShellRecordsCapability = fn;
  return () => { readShellRecordsCapability = probeShellRecordsCapability; };
}

/**
 * Count a foreground bash command the sandbox stopped at its granted second.
 *
 * Read off the result's own structured field rather than its prose: a clamped
 * command is answered rather than ending its run, so nothing about the run's
 * terminal state moves with the ceiling, and this is the only place the fact
 * crosses from the sandbox into something an operator can read.
 */
export function countForegroundTimeout(result: unknown): void {
  const outcome = (result as { structuredContent?: { outcome?: unknown; clamped?: unknown } })
    ?.structuredContent;
  if (outcome?.outcome !== "foreground_timeout") return;
  metrics.onBashForegroundTimeout(outcome.clamped === true);
}

/**
 * The sandbox answered, and the answer is that it does not know.
 *
 * Kept apart from a probe that failed to arrive. A blip is transient and giving
 * up on it eventually is right; this is the sandbox reporting that its own
 * durable state is unreadable, and treating a run of those as "idle" reclaims
 * exactly the sandbox whose records were lost.
 */
export class HandsLivenessIndeterminate extends Error {}

/** What Hands answers with when it cannot read its own shell records. */
export const HANDS_LIVENESS_INDETERMINATE = "shell_liveness_indeterminate";

/** What one dispatch answers with, whichever route asked. */
export type { ReclaimCause, ReapReport, ReapedShell };

/** Transport and scheduling slack on top of the grace the caller asked for. */
const REAP_TRANSPORT_OVERHEAD_MS = 15_000;

const REAP_OUTCOMES = ["stopped", "escalated", "surviving"] as const;

/**
 * The reap report, or an error.
 *
 * Each counter is checked against the entries actually carrying that outcome,
 * not merely against how many entries there are: a report claiming one stopped
 * beside a single entry marked surviving sums correctly and says the opposite
 * of what happened.
 */
function assertReapReport(body: unknown): ReapReport {
  const r = body as Partial<ReapReport> | null;
  const counts = REAP_OUTCOMES.map((k) => r?.[k]);
  if (!r || !Array.isArray(r.shells) || counts.some((n) => !Number.isInteger(n) || (n as number) < 0)) {
    throw new Error("hands_reap_failed: the sandbox's answer is not a reap report");
  }
  for (const entry of r.shells) {
    if (!entry || !REAP_OUTCOMES.includes(entry.outcome)) {
      throw new Error("hands_reap_failed: an addressed shell carries no outcome from the vocabulary");
    }
  }
  for (const [i, outcome] of REAP_OUTCOMES.entries()) {
    const carrying = r.shells.filter((e) => e.outcome === outcome).length;
    if (carrying !== counts[i]) {
      throw new Error(
        `hands_reap_failed: ${counts[i]} reported ${outcome}, `
        + `${carrying} addressed shells say so`,
      );
    }
  }
  const [stopped, escalated, surviving] = counts as number[];
  return { stopped, escalated, surviving, shells: r.shells };
}

/** What a classification read answered, or the safe reading when it could not. */
export interface ShellClassProbe {
  shellClass: string;
  collectorLive: boolean;
}

/**
 * A sandbox that cannot be asked reads as running: a run parked once too often
 * loses its slot for one call, while one not parked when it should have been
 * holds it for the whole wait timeout.
 */
const UNREADABLE_SHELL_CLASS: ShellClassProbe = { shellClass: "running", collectorLive: false };

export interface DispatchOutcome {
  text: string;
  isError: boolean;
  structured?: unknown;
}

/**
 * The shell id a background start gets when its caller named none.
 *
 * Derived, not minted: a fresh identifier on every call means a replay after a
 * crash looks for a row keyed by an id nothing wrote, finds nothing, and
 * dispatches the command a second time -- the duplicate execution the reference
 * row exists to prevent, on the path most starts take.
 *
 * Every input is durable before the dispatch and independent of anything the
 * model has to reproduce. A provider-issued tool-use identifier is neither: it
 * is not sealed until the turn's checkpoint, which is written after the tool
 * has already run, so a crash before that leaves the model re-queried and free
 * to hand back a different one -- and a different one is a different shell id
 * and a second execution. The owner scope and run identity are stamped on the
 * request; the command is the thing being dispatched. A resumed run that asks
 * the model afresh and gets a different command is a genuinely new intent, and
 * executing it is correct -- the guarantee is that one intent runs once, not
 * that one command text ever runs twice.
 *
 * The cost is stated rather than hidden: two starts of the *identical* command
 * under one run identity resolve to one shell, and the second is answered with
 * the first rather than started. That is the safe direction of the trade, and
 * the caller that wants two names them.
 */
export function commandDigestOf(owner: string, run: string, command: unknown): string {
  return createHmac("sha256", BRAIN_CHECKPOINT_KEY || "claw-bg-intent")
    .update(owner).update("\u0000")
    .update(run).update("\u0000")
    .update(typeof command === "string" ? command : "")
    .digest("hex");
}

/**
 * The id of the `sequence`-th start of this command under this run identity.
 *
 * Keyed rather than plain: every other input is either stored on the row beside
 * it or low-entropy, so an unkeyed digest would be a guessing oracle over the
 * command for anyone who can read the rows.
 */
export function derivedShellId(
  owner: string, run: string, command: unknown, sequence: number,
): string {
  const digest = createHmac("sha256", BRAIN_CHECKPOINT_KEY || "claw-bg-intent")
    .update(owner).update("\u0000")
    .update(run).update("\u0000")
    .update(String(sequence)).update("\u0000")
    .update(typeof command === "string" ? command : "")
    .digest("hex");
  return `bg-${digest.slice(0, 16)}`;
}

/**
 * Which start this is, and the id it gets, decided before anything is sent.
 *
 * Two requirements that pull apart. The identity has to survive a crash without
 * depending on the model reproducing anything -- a provider tool-use id is not
 * sealed until the turn's checkpoint, which is written after the tool has
 * already run. And it has to be per *start*: two deliberate starts of one
 * command are two intents and must produce two shells.
 *
 * Both hold by allocating against this run's own durable rows. A row still
 * `issued` or `dispatched` for this command is a call that was sent and never
 * confirmed -- which is exactly what a replay is -- so the replay adopts its id
 * and its sequence. Anything already `spawn_confirmed` is a start that
 * finished, so the next call is a new intent and takes the next sequence. The
 * sequence is Brain's own, never the model's.
 */
/**
 * Reconcile every start this run committed to and never confirmed.
 *
 * Called before a resumed run issues anything. A commitment whose call site
 * does not reappear is exactly the dispatch that was made and never
 * checkpointed: it is resolved on its own terms here rather than being matched
 * against whatever the resumed model happens to ask for next, so a new call is
 * genuinely new and the old one is not left outstanding behind it.
 */
export async function outstandingStarts(
  store: BgRowStore, owner: string, run: string,
): Promise<BgHandleRow[]> {
  const rows = await readRunRows(store, owner, run);
  return rows.filter((row) => row.state !== "spawn_confirmed");
}

export interface StartIdentity {
  shellId: string;
  commandDigest: string;
  sequence: number;
  /** True where this call adopted a predecessor's unfinished row. */
  replayed: boolean;
}

/**
 * Which start this is, and the id it gets, decided before anything is sent.
 *
 * Two requirements that pull apart. The identity has to survive a crash without
 * depending on the model reproducing anything -- a provider tool-use id is not
 * sealed until the turn's checkpoint, which is written after the tool has
 * already run. And it has to be per *start*: two deliberate starts of one
 * command are two intents and must produce two shells.
 *
 * Both hold by claiming a sequence number with an exclusive create. The create
 * is the arbitration: two concurrent calls cannot both win one sequence,
 * whatever order they scanned in, so neither can take the other's id. A row
 * this process has not claimed and that is not yet confirmed is a predecessor's
 * unfinished call, and only then is it adopted -- and adopting it claims it,
 * so a second concurrent call in the same process cannot adopt it again.
 *
 * A replica taking a run over after a handover has an empty claim set and
 * therefore adopts, which is what the design asks of a resumed run: its
 * predecessor's dispatched-and-unconfirmed call is exactly the one it must
 * reconcile rather than re-issue. The claiming replica is recorded on the row
 * so the handover is legible afterwards, not to gate that decision.
 */
export async function allocateStartIdentity(
  store: BgRowStore, owner: string, run: string, command: unknown,
  generation: string, stepIdentity: string | undefined,
): Promise<StartIdentity> {
  const commandDigest = commandDigestOf(owner, run, command);
  const rows = await readRunRows(store, owner, run);

  // The one row this call may take: the one its own call site sealed before a
  // previous dispatch of it, in whatever state that left it. Recognising a
  // replay by command text instead merges a genuinely new same-command call
  // into a predecessor's unfinished one, and does so silently. Confirmed rows
  // are matched too -- one call site owns one shell for good, and a replay of a
  // step that already finished is resolved from its row rather than started
  // again under a fresh id.
  const mine = stepIdentity
    ? rows.find((row) => row.stepIdentity === stepIdentity)
    : undefined;
  if (mine) {
    return {
      shellId: mine.shellId,
      commandDigest,
      sequence: mine.sequence ?? 1,
      replayed: true,
    };
  }

  // Walk upward until an exclusive create wins. A create that loses means some
  // other call took that sequence between the scan and here, which is the race
  // this loop exists to settle rather than to detect.
  const taken = new Set(rows.map((row) => row.sequence ?? 0));
  for (let sequence = 1; sequence <= taken.size + MAX_SEQUENCE_ATTEMPTS; sequence++) {
    if (taken.has(sequence)) continue;
    const shellId = derivedShellId(owner, run, command, sequence);
    const address = { ownerScope: owner, runIdentity: run, shellId };
    const claimed = await store.write(
      rowKey(address),
      JSON.stringify({
        ...address, generation, state: "issued", commandDigest, sequence,
        claimedBy: BRAIN_ID, ...(stepIdentity ? { stepIdentity } : {}),
      }),
      null,
    );
    if (!claimed) continue;
    return { shellId, commandDigest, sequence, replayed: false };
  }
  throw new Error(
    `no background-shell sequence could be claimed for this run under contention`,
  );
}

/** Bounded, because contention has to settle rather than climb forever. */
const MAX_SEQUENCE_ATTEMPTS = 16;

/**
 * Header naming who a tool call is for. Hands files background shells under it
 * so a sandbox handed to a new run cannot read or kill the previous
 * occupant's processes, and so a caller-chosen `shell_id` is private to its
 * owner instead of colliding across runs.
 */
export const OWNER_HEADER = "x-claw-owner";

/**
 * Header naming the single run making the call, inside that owner.
 *
 * Sent alongside the owner rather than instead of it: the owner is deliberately
 * wider than one run, so that a shell started in one turn of a conversation is
 * still pollable in the next, and something narrower is needed to say which
 * shells end when one run ends.
 */
export const RUN_HEADER = "x-claw-run";

/**
 * Header carrying the run's own deadline, which fixes how long a shell's
 * terminal outcome is kept.
 *
 * Stamped from the run's stamped deadline rather than derived from a constant:
 * two runs given different deadlines get different windows, and lowering the
 * constant later cannot shorten a window already fixed. Absent means no
 * deadline, which retains for the sandbox's life.
 */
export const DEADLINE_HEADER = "x-claw-deadline";

/**
 * A non-MCP Hands endpoint, given the MCP url the sandbox was created with.
 *
 * Hands is addressed by its `/mcp` url everywhere in Brain because that is the
 * only address the sandbox registry keeps. Its plain HTTP routes -- the health
 * check, the shell reaper -- hang off the same origin.
 */
export function handsEndpoint(handsMcpUrl: string, path: string): string {
  return `${handsMcpUrl.replace(/\/mcp\/?$/, "")}${path}`;
}

/**
 * The timeout this call will actually get, in seconds.
 *
 * Two fields, because two tools mean two different things by waiting. `bash`
 * has `timeout`, the ceiling on a command that is doing something; `wait` has
 * `timeout_sec`, the ceiling on doing nothing while a background shell runs.
 * Reading only the first meant a wait was measured against the hard cap
 * instead of its own limit -- harmless while the cap is the larger number, and
 * a silently truncated wait the moment it is not.
 *
 * A call that asked for more than its tool allows gets what the tool allows,
 * because that is what it will get from Hands too; one that named nothing gets
 * the same, there being nothing else to go on.
 */
function grantedTimeoutSec(toolName: string, args: Record<string, unknown>): number {
  const ceilingSec = toolTimeoutCeilingSec(toolName);
  for (const field of ["timeout", "timeout_sec"]) {
    const value = args[field];
    if (typeof value === "number" && value > 0) return Math.min(value, ceilingSec);
  }
  return ceilingSec;
}

/**
 * How long to allow one call: the timeout it will be granted, plus slack.
 *
 * The tool name is what makes the ceiling the right one. The argument alone
 * cannot: Hands clamps `bash {timeout: 3600}` to its own foreground limit and
 * answers there, so a deadline built from the number as sent buys an hour of
 * blocking for a call that could never have used it -- and with background
 * shells on, a `-32001` means the sandbox stopped answering, which is precisely
 * when an hour is the wrong thing to wait.
 */
export function callDeadlineMs(toolName: string, args: Record<string, unknown>): number {
  return grantedTimeoutSec(toolName, args) * 1000 + MCP_DEADLINE_SLACK_MS;
}

/**
 * MCP client for communicating with a Hands Tool MCP Server.
 * Per-request: each session gets its own HandsClient (different hands_mcp_url).
 */
export class HandsClient {
  private client: Client;
  private connected = false;
  /** Undefined until asked; see filesShellRecords. */
  private recordsCapability: boolean | undefined;
  /**
   * The sandbox generation a dispatch is recorded against.
   *
   * The MCP url, which is the strongest token available at this boundary: it
   * names one sandbox for its whole life and necessarily changes when one is
   * replaced, which is the only property a generation is asked for. A weaker
   * reading of it -- two creations coinciding -- would cost a `lost` answer its
   * distinction, never a second execution.
   */
  private get generation(): string {
    return this.url;
  }

  /**
   * `owner` is the scope a background shell is addressable in: the DAG root for
   * a DAG node, else the session. It outlives one run on purpose, so a shell
   * started in one turn is still pollable in the next turn of the same
   * conversation, which is the whole point of starting it in the background.
   *
   * `run` is the one execution making these calls, and is what lets a run that
   * ends take its own shells with it (see `reapShells`). Empty means the shells
   * this client starts belong to no run and are only stopped when Hands stops.
   */
  constructor(
    private url: string,
    private token: string,
    private owner: string = "",
    private run: string = "",
    private deadlineAt: string = "",
  ) {
    this.client = new Client(
      { name: "brain", version: "1.0.0" },
      { capabilities: {}, requestTimeoutMs: 0 } as any,
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StreamableHTTPClientTransport(
      new URL(this.url),
      {
        // Use undici's OWN fetch (v8) rather than Node's built-in global fetch
        // (internal undici v6). This must match the undici version of
        // HANDS_DISPATCHER below; mixing v6 fetch with a v8 dispatcher throws
        // `invalid onRequestStart method`. See HANDS_DISPATCHER doc above.
        // Cast to the DOM `fetch` type the SDK's FetchLike expects.
        fetch: undiciFetch as unknown as typeof fetch,
        requestInit: {
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(this.owner ? { [OWNER_HEADER]: this.owner } : {}),
            ...(this.run ? { [RUN_HEADER]: this.run } : {}),
            ...(this.deadlineAt ? { [DEADLINE_HEADER]: this.deadlineAt } : {}),
          },
          // undici-only escape hatch: attach a long-lived Agent that disables
          // the 5-min headersTimeout / bodyTimeout. See HANDS_DISPATCHER doc
          // above. Cast through `unknown` because the standard `RequestInit`
          // does not type `dispatcher` (it is a Node/undici extension).
          dispatcher: HANDS_DISPATCHER,
        } as unknown as RequestInit,
      },
    );
    await this.client.connect(transport);
    this.connected = true;
    logger.info({ url: this.url }, "hands.connected");
  }

  /**
   * Whether this sandbox files durable shell records, cached for the client's
   * life.
   *
   * The answer decides how a shell is addressed, so it has to be established
   * before the first background call rather than assumed. A sandbox that cannot
   * be asked is treated as filing none, which is the more restrictive of the two
   * -- it costs a run-qualified id a record-writing Hands would have accepted
   * unqualified, and never the other way round.
   */
  private async filesShellRecords(): Promise<boolean> {
    if (this.recordsCapability === undefined) {
      // A read that fails answers the more restrictive of the two, wherever it
      // fails: it costs a run-qualified id a record-writing Hands would have
      // taken plain, never an address left unenforced.
      this.recordsCapability = await readShellRecordsCapability(this.url).catch(() => false);
    }
    return this.recordsCapability;
  }

  /**
   * The shell id to put on the wire, and the one to hand back to the model.
   *
   * Against a sandbox that partitions by owner scope and id alone, the run half
   * of the address would go unenforced for as long as it answers -- two runs
   * sharing an owner could read and terminate each other's shells, which has no
   * mixed-version exemption. The boundary is folded into the id by a total
   * injective transform, so two run identities can never present one wire id
   * whatever the model names. The public id never changes: the transform is
   * applied at this boundary and undone on the way back.
   */
  private async wireShellId(id: string): Promise<string> {
    if (!this.run || await this.filesShellRecords()) return id;
    return runQualifiedShellId(this.run, id);
  }

  /** Rewrite the `shell_id` argument for the wire, leaving everything else. */
  private async wireArgs(
    name: string, args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = args.shell_id;
    if (!isShellAddressingCall(name, args) || typeof id !== "string" || !id) return args;
    return { ...args, shell_id: await this.wireShellId(id) };
  }

  /**
   * The credential the internal routes take their scope from.
   *
   * Minted per call rather than held, because the run half changes with the
   * client's own binding and a stale proof would name the wrong scope. The
   * secret is the sandbox's internal token, which no model-issued process can
   * read, so a proof reaching one authorises that scope and nothing else.
   */
  private scopedCredential(): string {
    return mintScopeCredential({ owner: this.owner, run: this.run || null }, this.token);
  }

  /**
   * The class of one shell, read without consuming a byte of its output.
   *
   * Asked before a `wait` is routed, so the decision to hand back the pod's
   * execution slot is taken from evidence rather than from the tool's name. A
   * sandbox that cannot answer is treated as running: parking a run that did
   * not need to park costs a slot for one call, while failing to park one that
   * did holds it for the whole wait timeout.
   */
  async classifyShell(shellId: string, timeoutMs = 10_000): Promise<ShellClassProbe> {
    try {
      const resp = await undiciFetch(handsEndpoint(this.url, "/internal/shells/class"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.scopedCredential()}`, "content-type": "application/json" },
        body: JSON.stringify({ shell_id: await this.wireShellId(shellId) }),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: HANDS_DISPATCHER,
      } as Parameters<typeof undiciFetch>[1]);
      if (!resp.ok) return UNREADABLE_SHELL_CLASS;
      const body = await resp.json() as { shell_class?: unknown; collector_live?: unknown };
      if (typeof body?.shell_class !== "string") return UNREADABLE_SHELL_CLASS;
      return { shellClass: body.shell_class, collectorLive: body.collector_live === true };
    } catch {
      return UNREADABLE_SHELL_CLASS;
    }
  }

  /**
   * What the sandbox's own records say about one shell.
   *
   * Read-only and starts nothing on any version, so a Brain may ask before
   * deciding whether a start is a first call. A sandbox that cannot be asked,
   * or one that files no records, answers indeterminate -- which sends nothing.
   */
  private async probeShellRecord(shellId: string): Promise<RecordProbe> {
    try {
      const resp = await undiciFetch(handsEndpoint(this.url, "/internal/shells/record"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.scopedCredential()}`, "content-type": "application/json" },
        body: JSON.stringify({ shell_id: shellId }),
        signal: AbortSignal.timeout(10_000),
        dispatcher: HANDS_DISPATCHER,
      } as Parameters<typeof undiciFetch>[1]);
      if (!resp.ok) return { kind: "indeterminate" };
      const body = await resp.json() as {
        marker?: boolean; subtreeReadable?: boolean; present?: boolean;
      };
      if (body?.present) return { kind: "record_present" };
      if (body?.marker && body?.subtreeReadable) return { kind: "determinately_absent" };
      return { kind: "indeterminate" };
    } catch {
      return { kind: "indeterminate" };
    }
  }

  /**
   * Fix the shell id of a background start before it is dispatched.
   *
   * The common start names no id and lets the sandbox mint one. That is the
   * path with no protection at all: there is nothing to key a reference row by
   * before the request goes out, so the crash window it closes stays open, and
   * against a sandbox that partitions by owner alone the id that comes back is
   * one Brain never qualified and can never address again. Minting here fixes
   * both by making every start a named one -- the value is in the sandbox's own
   * format and the model is told the same string either way.
   */
  private async fixStartArgs(
    args: Record<string, unknown>, store: BgRowStore | null, stepIdentity: string | undefined,
  ): Promise<{ args: Record<string, unknown>; carry: StartCarry }> {
    if (typeof args.shell_id === "string" && args.shell_id) {
      return { args, carry: {} };
    }
    if (!store || !this.owner || !this.run) {
      // Nothing durable to allocate against -- an out-of-band caller with no
      // scope of its own. Today's behaviour: the sandbox mints the id.
      return { args, carry: {} };
    }
    const allocated = await allocateStartIdentity(
      store, this.owner, this.run, args.command, this.generation, stepIdentity,
    );
    return {
      args: { ...args, shell_id: allocated.shellId },
      carry: {
        commandDigest: allocated.commandDigest,
        sequence: allocated.sequence,
        claimedBy: BRAIN_ID,
        ...(stepIdentity ? { stepIdentity } : {}),
      },
    };
  }

  /**
   * The address a background start is deduplicated under, or null for a caller
   * with no scope of its own -- a probe or an out-of-band request, which has no
   * run to key a row by and no intent to deduplicate.
   */
  private startAddress(args: Record<string, unknown>): BgHandleAddress | null {
    const shellId = args.shell_id;
    if (!this.owner || !this.run || typeof shellId !== "string" || !shellId) return null;
    return { ownerScope: this.owner, runIdentity: this.run, shellId };
  }

  /**
   * One dispatch, whichever result shape the caller wants.
   *
   * Both entry points go through here so neither is a way round the other's
   * protection: the script route used to carry the id rewriting and none of the
   * start resolution, which left a script step replaying a command the same
   * crash could run twice.
   */
  private async dispatch(
    name: string, args: Record<string, unknown>, signal?: AbortSignal, ctx: CallContext = {},
  ): Promise<DispatchOutcome> {
    await this.connect();
    const isStart = name === "bash" && args.run_in_background === true;
    const store = bgRowStore();
    const start = isStart
      ? await this.fixStartArgs(args, store, ctx.stepIdentity)
      : { args, carry: {} as StartCarry };
    const fixed = start.args;
    const address = isStart ? this.startAddress(fixed) : null;
    if (address && store) {
      const settled = await this.resolveBackgroundStart(address, store, start.carry);
      if (settled) return settled;
    }

    const wired = await this.wireArgs(name, fixed);
    const result = await this.client.callTool(
      { name, arguments: wired },
      undefined,
      { timeout: callDeadlineMs(name, args), signal } as any,
    );
    countForegroundTimeout(result);
    const isError = !!(result as { isError?: boolean }).isError;
    const texts = (result.content as Array<{ type: string; text?: string }>)
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    // Durable before the result reaches the caller, so a crash after the spawn
    // cannot leave a shell nothing attests to.
    if (address && store && !isError) {
      await advanceRow(store, address, this.generation, "spawn_confirmed", start.carry);
    }
    // The caller is told the id it sent, or the one minted for it -- never the
    // wire form, which is Brain's business and an id nothing else can reproduce.
    return {
      text: restorePublicShellId(texts || "", wired.shell_id, fixed.shell_id),
      isError,
      structured: restoreStructuredShellId(
        (result as { structuredContent?: unknown; structured?: unknown }).structuredContent
          ?? (result as { structured?: unknown }).structured,
        wired.shell_id,
        fixed.shell_id,
      ),
    };
  }

  /**
   * Decide a background start against its reference row before sending it.
   *
   * The row records how far a previous dispatch of this same start got, and the
   * two crash windows it separates lead opposite ways: a request that never
   * reached the transport must be sent, and one that may have reached Hands must
   * not be sent a second time. Returns the answer to give the caller, or null to
   * go ahead and dispatch.
   */
  private async resolveBackgroundStart(
    address: BgHandleAddress, store: BgRowStore, carry: StartCarry,
  ): Promise<DispatchOutcome | null> {
    let row: BgHandleRow | null = null;
    let rowReadable = true;
    try {
      row = await readRow(store, address);
    } catch (err) {
      logger.warn({ err: String(err), shellId: address.shellId }, "bg_start.row_unreadable");
      rowReadable = false;
    }

    const decision = await resolveStart({
      row,
      rowReadable,
      currentGeneration: this.generation,
      sandboxFilesRecords: await this.filesShellRecords(),
      probe: () => this.probeShellRecord(address.shellId),
    });

    logger.info(
      { shellId: address.shellId, action: decision.action, reported: decision.reported },
      "bg_start.resolved",
    );
    // Two different answers, and collapsing them costs a script step its
    // outcome: a start that was already made is a success carrying the existing
    // shell, while one that cannot be resolved is a genuine failure. Reported
    // as one, a safely-deduplicated replay fails a step whose work is done.
    if (decision.action === "resolve") {
      return {
        text: `Background shell ${address.shellId} was already started by this request; `
          + `nothing was run a second time (${decision.reported}`
          + `${decision.shellClass ? `, ${decision.shellClass}` : ""}). ${decision.reason}.`,
        isError: false,
        structured: {
          shell_id: address.shellId,
          resolution: decision.reported,
          ...(decision.shellClass ? { shell_class: decision.shellClass } : {}),
        },
      };
    }
    if (decision.action === "refuse") {
      return {
        text: `Error: whether background shell ${address.shellId} was started cannot be `
          + `determined, so it was not started again. ${decision.reason}.`,
        isError: true,
        structured: { shell_id: address.shellId, resolution: decision.reported },
      };
    }
    // A first call writes both states; a retransmission's row already carries
    // them and re-writing is a no-op the advance recognises.
    await advanceRow(store, address, this.generation, "issued", carry);
    await advanceRow(store, address, this.generation, "dispatched", carry);
    return null;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<string> {
    return (await this.dispatch(name, args, signal, ctx)).text;
  }

  /**
   * Like `callTool` but preserves the McpResult shape (isError, structured)
   * so callers can distinguish a non-zero exit from a successful run that
   * happens to have a non-empty stderr. Script-runner uses this so the
   * `on_fail` policy fires on shell failures (bash exit != 0) rather than
   * silently capturing the error text and proceeding.
   */
  async callToolFull(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: CallContext,
  ): Promise<DispatchOutcome> {
    return this.dispatch(name, args, signal, ctx);
  }

  /**
   * End the background shells this run started, and report how many there were.
   *
   * A run that will not be resumed leaves its background work with nobody to
   * read it, still holding CPU in a sandbox the rest of the workspace shares.
   * Only the caller knows whether that is the case -- a conversation between
   * turns has not ended and its shells must survive -- so this is never called
   * from here, only from a terminal path that has decided.
   *
   * Not an MCP tool call: by the time a run is over, the model is not being
   * asked anything, and a tool would let it reap on its own. Plain HTTP also
   * means this works when the MCP transport was never opened, which is the
   * common case for a run that ended without touching a sandbox.
   */
  async reapShells(cause: ReclaimCause, reclaimOp: string, graceMs = BG_SHELL_REAP_GRACE_MS): Promise<ReapReport> {
    if (!this.run) return { stopped: 0, escalated: 0, surviving: 0, shells: [] };
    const resp = await undiciFetch(handsEndpoint(this.url, "/internal/shells/reap"), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.scopedCredential()}`, "content-type": "application/json" },
      body: JSON.stringify({ cause, reclaim_op: reclaimOp, grace_ms: graceMs }),
      // Derived from the grace rather than fixed beside it: a deadline chosen
      // independently leaves the top of the grace domain unusable end to end,
      // the client aborting before the escalation it asked for has reported.
      signal: AbortSignal.timeout(graceMs + REAP_TRANSPORT_OVERHEAD_MS),
      dispatcher: HANDS_DISPATCHER,
    } as Parameters<typeof undiciFetch>[1]);
    if (!resp.ok) throw new Error(`hands_reap_failed: status=${resp.status}`);

    // Never defaulted to zero. A malformed or truncated answer is a reap whose
    // outcome nobody knows, and reading it as "nothing survived" is the same
    // untruth the counts were reshaped to remove.
    return assertReapReport(await resp.json().catch(() => null));
  }

  async listTools(): Promise<string[]> {
    await this.connect();
    const tools = await this.client.listTools();
    return tools.tools.map((t) => t.name);
  }

  /**
   * Close the transport, under a ceiling.
   *
   * The ceiling is the point. A close against a sandbox that is already gone
   * waits on the transport, which has no deadline of its own, and this runs from
   * the run's finally block -- an unbounded await there holds the run's slot open
   * and eats into the SIGTERM grace window, which is the same hazard
   * withHandsTimeout exists for on the callTool side.
   *
   * The timeout resolves rather than rejects: nothing downstream acts on a failed
   * close, so a caller that has finished with this client should carry on rather
   * than handle an error. `connected` is cleared before the await for the same
   * reason -- a close that times out has to leave the client unusable rather than
   * looking connected, and a second call must not wait again.
   */
  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn({ url: this.url, timeoutMs: HANDS_CLOSE_TIMEOUT_MS }, "hands.close_timeout");
            resolve();
          }, HANDS_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch { /* ignore: the transport is being discarded either way */ } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Promise.race wrapper enforcing a hard ceiling on a single hands.callTool
 * RPC (checkpoint-architecture-redesign §5.5.2). Used by workspace_sync /
 * workspace_restore and the sandbox probe; user-facing tool dispatch from
 * the agent loop continues to rely on the MCP-level timeout + tool-level
 * argument timeout instead.
 *
 * The grep-based CI guard lint-no-direct-hands-calltool-in-workspace.sh
 * enforces the invariant that workspace/sync.ts / workspace/reaper.ts
 * never call hands.callTool() directly — they must go through this
 * helper so a wedged RPC cannot hang the SIGTERM grace window.
 *
 * Cancellation rules:
 *   - If signal is already aborted on entry, throw signal.reason synchronously.
 *   - If signal aborts mid-flight, reject with signal.reason and clean up.
 *   - If timeoutMs elapses first, reject with a "hands_call_timeout" Error
 *     carrying the tool name + timeout so logs are searchable.
 *
 * Note: the underlying hands.callTool() does not currently observe an
 * AbortSignal (MCP SDK 1.12 surface), so the timeout/abort here only
 * unblocks the awaiter — the remote tool may keep running until it exits
 * on its own. Callers that need true cancellation must layer their own
 * abort propagation on top (workspace_sync uses sandbox-side bash trap).
 */
export async function withHandsTimeout<T>(
  hands: HandsClient,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number = HANDS_CALL_DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("hands_call_aborted");
  }
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race<T>([
      hands.callTool(tool, args, signal) as unknown as Promise<T>,
      new Promise<T>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`hands_call_timeout: tool=${tool} timeoutMs=${timeoutMs}`)),
          timeoutMs,
        );
        if (signal) {
          abortListener = () => rej(signal.reason ?? new Error("hands_call_aborted"));
          signal.addEventListener("abort", abortListener, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

/**
 * How many background shells are still running for `owner`.
 *
 * A free function rather than a method because the caller that needs it most is
 * the keepalive sweep, which walks KV entries and has a URL and a token but no
 * client: building one there would mean constructing an MCP client to make one
 * plain HTTP call.
 *
 * Throws on transport or status failure rather than reporting zero. Zero and
 * "could not tell" lead to opposite decisions -- the first says a sandbox is
 * free, the second says nothing at all -- and a caller that cannot see the
 * difference will eventually reclaim a sandbox because Hands was briefly
 * unreachable.
 *
 * That applies to every way the answer can fail to arrive, not just the ones
 * with a status code. A 200 whose body is missing `running`, or carries
 * something that is not a count, is a Hands that did not answer the question --
 * an older build without the route behind a proxy that rewrites 404s, a
 * truncated body, a JSON error object. Defaulting those to zero reports a
 * confirmed absence of work, which is the one thing this must never invent.
 *
 * An empty owner is refused for the same reason and in the same direction: it
 * names no bucket, so no count about it can be true. Reporting zero would say
 * the sandbox is free on the strength of a question nobody asked.
 */
export async function countActiveShells(
  url: string,
  token: string,
  owner: string,
  timeoutMs = 5_000,
): Promise<number> {
  if (!owner) throw new Error("hands_active_shells_failed: empty owner");
  const resp = await undiciFetch(handsEndpoint(url, "/internal/shells/active"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mintScopeCredential({ owner, run: null }, token)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: HANDS_DISPATCHER,
  } as Parameters<typeof undiciFetch>[1]);
  const body = await resp.json().catch(() => null) as
    { running?: unknown; error?: unknown } | null;
  // The sandbox saying it cannot tell is a different fact from a refusal, and
  // from a probe that did not arrive: no number of repetitions turns it into
  // "idle". Keyed on what it said rather than on the status alone, so an
  // unrelated 503 keeps meaning what it meant.
  if (body?.error === HANDS_LIVENESS_INDETERMINATE) {
    throw new HandsLivenessIndeterminate(
      "hands_active_shells_indeterminate: the sandbox cannot read its own shell records",
    );
  }
  if (!resp.ok) throw new Error(`hands_active_shells_failed: status=${resp.status}`);
  const running = body?.running;
  if (typeof running !== "number" || !Number.isFinite(running) || running < 0) {
    throw new Error(`hands_active_shells_failed: malformed body running=${String(running)}`);
  }
  return running;
}
