// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import { BG_SHELL_ENABLED, HANDS_CALL_DEFAULT_TIMEOUT_MS, HANDS_CLOSE_TIMEOUT_MS } from "../config.js";
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.connect();
    // The deadline follows what the tool said it needs; see callDeadlineMs.
    // Without one an LLM-issued `bash {timeout: 330}` would block the Brain for
    // up to an hour if Hands went away mid-command, which is the deadlock this
    // fixed.
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: callDeadlineMs(name, args), signal } as any,
    );
    const texts = (result.content as Array<{ type: string; text?: string }>)
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    return texts || "";
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
  ): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    await this.connect();
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: callDeadlineMs(name, args), signal } as any,
    );
    const texts = (result.content as Array<{ type: string; text?: string }>)
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
    return {
      text: texts || "",
      isError: !!(result as { isError?: boolean }).isError,
      structured: (result as { structuredContent?: unknown; structured?: unknown }).structuredContent
        ?? (result as { structured?: unknown }).structured,
    };
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
  async reapShells(timeoutMs = 15_000): Promise<number> {
    if (!this.run) return 0;
    const resp = await undiciFetch(handsEndpoint(this.url, "/internal/shells/reap"), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ run: this.run }),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: HANDS_DISPATCHER,
    } as Parameters<typeof undiciFetch>[1]);
    if (!resp.ok) throw new Error(`hands_reap_failed: status=${resp.status}`);
    const body = await resp.json() as { stopped?: number };
    return body?.stopped ?? 0;
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
 */
export async function countActiveShells(
  url: string,
  token: string,
  owner: string,
  timeoutMs = 5_000,
): Promise<number> {
  if (!owner) return 0;
  const resp = await undiciFetch(handsEndpoint(url, "/internal/shells/active"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ owner }),
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: HANDS_DISPATCHER,
  } as Parameters<typeof undiciFetch>[1]);
  if (!resp.ok) throw new Error(`hands_active_shells_failed: status=${resp.status}`);
  const body = await resp.json() as { running?: number };
  return body?.running ?? 0;
}
