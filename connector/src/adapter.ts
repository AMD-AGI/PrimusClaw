// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** One agent adapter process and the ACP connection to it (newline-delimited JSON-RPC over its stdio). */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { adapterStore } from "./adapter-install.js";
import type { AgentConfig } from "./config.js";
import type { ChildRegistry } from "./children.js";
import { redactText } from "./redact.js";
import { errMessage, isObject } from "./util.js";

export type AcpParams = Record<string, any>;

export interface AdapterHooks {
  onUpdate(update: AcpParams, params: AcpParams): void;
  onPermission(params: AcpParams): Promise<AcpParams>;
  /** A request the adapter blocks on that is not part of ACP itself (the `cursor/*` extensions). */
  onExtension(method: string, params: AcpParams): Promise<AcpParams>;
  onNotification(method: string, params: AcpParams): void;
  onStderr(line: string): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void;
}

export interface AdapterStart {
  cfg: AgentConfig;
  registry: ChildRegistry;
  sessionId: string;
  cwd: string;
  hooks: AdapterHooks;
  /** The adapter's stderr goes here and nowhere else. */
  logFile: string;
  version: string;
  initTimeoutMs?: number;
}

/** The sign-in an adapter reports it uses (`_auth/status_update`, claude-agent-acp); `kind: "none"` is a known sign-out. */
export interface AuthStatus { kind: string; label?: string }

export const AUTH_STATUS_METHOD = "_auth/status_update";

export class AdapterProcess {
  caps: AcpParams = {};
  /** The ways to sign in the adapter offered at `initialize` (`authMethods`), for `authenticate`. */
  authMethods: AcpParams[] = [];
  /** The last sign-in it reported, if it reports one; see {@link waitAuthStatus}. */
  authStatus: AuthStatus | null = null;
  exited = false;
  private conn!: acp.ClientConnection;
  private authWaiters: Array<() => void> = [];

  private constructor(readonly child: ChildProcess, readonly pid: number, private readonly registry: ChildRegistry) {}

  static async start(o: AdapterStart): Promise<AdapterProcess> {
    // The log is written as a stream (off the event loop): it sits in the state directory, which may be a network disk
    // that stalls, and an adapter's stderr must not freeze the connector. Past 1 MiB waiting for the disk, lines are dropped.
    await fsp.mkdir(path.dirname(o.logFile), { recursive: true, mode: 0o700 });
    // `CLAW_CONNECTOR_AGENT` marks a session this connector runs: the approval hooks leave its questions alone (they already reach
    // the phone through the adapter), as `CLAUDE_CODE_ENTRYPOINT` does for Claude Code (approval-hook.ts).
    const env = { ...process.env, ...o.cfg.env, CLAW_CONNECTOR_AGENT: o.cfg.id };
    // A pinned preset runs from the copy installed in the connector's directory, never through npx in the session's
    // folder (adapter-install.ts). The session's folder reaches the adapter in session/new either way.
    const run = (await adapterStore()?.launch(o.cfg, o.cwd, env)) ?? { command: o.cfg.command, args: o.cfg.args, cwd: o.cwd };
    const log = fs.createWriteStream(o.logFile, { flags: "a", mode: 0o600 });
    log.on("error", () => { /* the log is best effort */ });
    const child = spawn(run.command, run.args, {
      cwd: run.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so the whole tree (an npx wrapper and the agent below it) can be stopped as one.
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(new Error(`could not start ${run.command}: ${errMessage(e)}`)));
    }).catch((e) => { log.end(); throw e; });
    const pid = child.pid!;
    o.registry.add({ pid, pgid: pid, agent_id: o.cfg.id, session_id: o.sessionId });
    const a = new AdapterProcess(child, pid, o.registry);

    // Redaction needs a whole line: a credential split across two chunks must not slip through, so nothing is written until a newline (or the end).
    let tail = "";
    const flushLine = (line: string) => {
      const text = redactText(line).text;
      if (log.writableLength < 1024 * 1024) log.write(text + "\n");
      try { o.hooks.onStderr(text); } catch { /* a hook must not break the stream */ }
    };
    child.stderr!.on("data", (d: Buffer) => {
      tail += d.toString("utf8");
      let nl: number;
      while ((nl = tail.indexOf("\n")) >= 0) {
        flushLine(tail.slice(0, nl));
        tail = tail.slice(nl + 1);
      }
      if (tail.length > 64 * 1024) { flushLine(tail); tail = ""; }
    });
    child.stderr!.once("close", () => { if (tail) { flushLine(tail); tail = ""; } log.end(); });
    child.stdin!.on("error", () => { /* the adapter went away; the exit handler reports it */ });
    child.once("exit", (code, signal) => {
      a.exited = true;
      void o.registry.reap(pid).catch(() => undefined);
      o.hooks.onExit({ code, signal });
    });

    const app = acp.client({ name: "claw-connector" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => (await o.hooks.onPermission(params as AcpParams)) as never)
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        const p = params as AcpParams;
        o.hooks.onUpdate(p.update as AcpParams, p);
      })
      .onRequest("*", async (ctx) => {
        if (ctx.method.startsWith("cursor/")) return (await o.hooks.onExtension(ctx.method, (ctx.params ?? {}) as AcpParams)) as never;
        throw acp.RequestError.methodNotFound(ctx.method);
      })
      .onNotification("*", async (ctx) => {
        const params = (ctx.params ?? {}) as AcpParams;
        if (ctx.method === AUTH_STATUS_METHOD && params.authStatus && typeof params.authStatus.kind === "string") {
          a.authStatus = { kind: params.authStatus.kind, ...(typeof params.authStatus.label === "string" ? { label: params.authStatus.label } : {}) };
          for (const w of a.authWaiters.splice(0)) w();
        }
        o.hooks.onNotification(ctx.method, params);
      });

    a.conn = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    try {
      const init = await withTimeout(
        a.conn.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "claw-connector", title: "Claw connector", version: o.version } }),
        o.initTimeoutMs ?? 120_000, "initialize",
      );
      a.caps = ((init as AcpParams).agentCapabilities ?? {}) as AcpParams;
      const methods = (init as AcpParams).authMethods;
      a.authMethods = Array.isArray(methods) ? methods.filter((m: unknown) => typeof m === "object" && m !== null) : [];
      // Its pid must be on record before it is used: after a crash the next run stops what children.json names, and an
      // adapter it does not name would be left running. A state directory that does not take the record (in a bounded
      // time) fails the start.
      if (!(await o.registry.flushed())) throw new Error("could not record the adapter's process: the state directory did not answer");
    } catch (e) {
      await a.kill();
      throw e;
    }
    return a;
  }

  /** Whether the adapter says it reports its sign-in (`agentCapabilities._meta.authStatus`). */
  get reportsAuth(): boolean {
    const meta = this.caps._meta as AcpParams | undefined;
    return !!meta && typeof meta === "object" && meta.authStatus !== undefined;
  }

  /**
   * The sign-in the adapter reports, waiting up to `ms` for its first report (claude-agent-acp sends it shortly after
   * `initialize`, and again for each new session). Null when it reports nothing in that time: not known, not "none".
   */
  async waitAuthStatus(ms: number): Promise<AuthStatus | null> {
    if (this.authStatus || !this.reportsAuth || ms <= 0) return this.authStatus;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        // A waiter that timed out leaves the list, so a long-lived adapter does not collect them.
        const i = this.authWaiters.indexOf(done);
        if (i >= 0) this.authWaiters.splice(i, 1);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      this.authWaiters.push(done);
    });
    return this.authStatus;
  }

  /**
   * `open` (a `session/new`, `session/resume` or `session/load`), signing the adapter in first when it needs that and can
   * do it by itself: an adapter that answers "Authentication required" and offers an `api-key` method, while `env` (the
   * connector's environment with the agent's `[agents.env]` over it) holds a key it reads (codex-acp: OPENAI_API_KEY or
   * CODEX_API_KEY), is told to `authenticate` with it and asked once more. The key itself is never sent: the adapter
   * reads its own environment. `onAuthenticate` runs before the `authenticate` request; a failed `authenticate` throws
   * {@link AuthenticateFailed}. Sessions and `doctor`'s adapter check both open this way, so `doctor` passes an agent
   * whose sessions open.
   */
  async openSignedIn<T>(env: Record<string, string | undefined>, open: () => Promise<T>, onAuthenticate?: (method: string) => void): Promise<T> {
    try {
      return await open();
    } catch (e) {
      const method = this.apiKeyMethod();
      if (!isAuthRequiredError(e) || !method || !hasApiKeyEnv(env)) throw e;
      onAuthenticate?.(method);
      try { await this.request("authenticate", { methodId: method }); } catch (ae) { throw new AuthenticateFailed(method, ae); }
      return await open();
    }
  }

  /** The id of an `authenticate` method that signs in with an API key the adapter reads from its own environment. */
  apiKeyMethod(): string | null {
    for (const m of this.authMethods) {
      const id = typeof m.id === "string" ? m.id : typeof m.methodId === "string" ? m.methodId : null;
      if (id === "api-key") return id;
    }
    return null;
  }

  request(method: string, params: AcpParams, timeoutMs = 60_000): Promise<AcpParams> {
    return withTimeout(this.conn.agent.request(method, params as never) as Promise<AcpParams>, timeoutMs, method);
  }

  /** A request with no deadline: a prompt runs as long as the turn does. */
  requestUnbounded(method: string, params: AcpParams): Promise<AcpParams> {
    return this.conn.agent.request(method, params as never) as Promise<AcpParams>;
  }

  async notify(method: string, params: AcpParams): Promise<void> {
    await this.conn.agent.notify(method, params as never);
  }

  /** Stop the adapter and everything it started: its whole process group. */
  async kill(): Promise<void> {
    try { this.conn?.close(); } catch { /* already closed */ }
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    // Only this adapter's own group. The group can outlive its leader (an npx wrapper's child), so it is signalled even after exit.
    await this.registry.kill(this.pid, 1500).catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** An adapter error that says the agent is not signed in. */
export function isAuthRequiredError(e: unknown): boolean {
  return /authentication required|auth_required|not logged in|login required/i.test(errMessage(e)) || (isObject(e) && (e as { code?: unknown }).code === -32000);
}

/** Whether an adapter's environment holds an OpenAI/Codex key its `api-key` sign-in reads. */
export function hasApiKeyEnv(env: Record<string, string | undefined>): boolean {
  return ["CODEX_API_KEY", "OPENAI_API_KEY"].some((k) => typeof env[k] === "string" && env[k]!.trim() !== "");
}

/** `authenticate` itself failed: the agent stays signed out. */
export class AuthenticateFailed extends Error {
  constructor(readonly method: string, cause: unknown) { super(`authenticate ${method} failed: ${errMessage(cause)}`); }
}
