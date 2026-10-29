// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** One agent adapter process and the ACP connection to it (newline-delimited JSON-RPC over its stdio). */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentConfig } from "./config.js";
import type { ChildRegistry } from "./children.js";
import { redactText } from "./redact.js";
import { errMessage } from "./util.js";

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

export class AdapterProcess {
  caps: AcpParams = {};
  exited = false;
  private conn!: acp.ClientConnection;

  private constructor(readonly child: ChildProcess, readonly pid: number, private readonly registry: ChildRegistry) {}

  static async start(o: AdapterStart): Promise<AdapterProcess> {
    fs.mkdirSync(path.dirname(o.logFile), { recursive: true, mode: 0o700 });
    const log = fs.openSync(o.logFile, "a", 0o600);
    const child = spawn(o.cfg.command, o.cfg.args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so the whole tree (an npx wrapper and the agent below it) can be stopped as one.
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(new Error(`could not start ${o.cfg.command}: ${errMessage(e)}`)));
    }).catch((e) => { fs.closeSync(log); throw e; });
    const pid = child.pid!;
    o.registry.add({ pid, pgid: pid, agent_id: o.cfg.id, session_id: o.sessionId });
    const a = new AdapterProcess(child, pid, o.registry);

    // Redaction needs a whole line: a credential split across two chunks must not slip through, so nothing is written until a newline (or the end).
    let tail = "";
    const flushLine = (line: string) => {
      const text = redactText(line).text;
      try { fs.writeSync(log, text + "\n"); } catch { /* the log is best effort */ }
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
    child.stderr!.once("close", () => { if (tail) { flushLine(tail); tail = ""; } try { fs.closeSync(log); } catch { /* already closed */ } });
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
      .onNotification("*", async (ctx) => { o.hooks.onNotification(ctx.method, (ctx.params ?? {}) as AcpParams); });

    a.conn = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    try {
      const init = await withTimeout(
        a.conn.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "claw-connector", title: "Claw connector", version: o.version } }),
        o.initTimeoutMs ?? 120_000, "initialize",
      );
      a.caps = ((init as AcpParams).agentCapabilities ?? {}) as AcpParams;
    } catch (e) {
      await a.kill();
      throw e;
    }
    return a;
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
