// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A fake world for the AppRunner: an in-memory `claw_app_runs` row, a SaFE that
 * hands out and kills workloads, and a sandbox filesystem and process table that
 * answer the runner's EnvD commands.
 *
 * The state directory is shared storage, so its files outlive a workload; the
 * process table is per workload, as it is per container. The commands the runner
 * sends are recognised by shape (see `exec`), and the shapes are the ones the
 * real shell is run against in app-runner-shell.test.ts, so a command the fake
 * understands and the real `sh` does not is caught there.
 */
import {
  APP_MANIFEST_SCHEMA, type AppManifestV1,
} from "@claw/protocol";
import {
  AppRunWriteRefused, type AppRunPatch, type AppRunRecord, type AppRunSecrets, type AppRunState, type AppRunStore,
} from "../../src/apps/app-run-store.js";
import type { AppSandboxOps } from "../../src/apps/app-runner.js";
import type { SandboxExecOptions, SandboxInstance } from "../../src/sandbox/provider.js";

export const RUN_ID = "run-1";
export const TOKEN = "cmt_Zk3Qp9Lw7Xv2Nb5Hd8Ts1Ay4Ge6Rj0Uc";
export const KEY_M = "e2b_measurementKEY0123456789abcdef";
export const KEY_S = "e2b_subrunKEY0123456789abcdefghij";
export const STATE_DIR = `/data/.claw-apps/${RUN_ID}`;
export const T0 = Date.parse("2026-01-01T00:00:00.000Z");

export const b64 = (s: string): string => Buffer.from(s).toString("base64");

export const MANIFEST: AppManifestV1 = {
  schema: APP_MANIFEST_SCHEMA,
  name: "demo-app",
  version: "1.0.0",
  container: { image: "img:1" },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["python", "-m", "app", "--name", "it's"],
  bootstrap: { file: "boot/start.sh", content_b64: b64("#!/bin/sh\necho boot\n") },
  env: { STATIC: "1", OVERRIDE_ME: "from-manifest" },
  env_map: {
    run_id: "APP_RUN_ID",
    run_created_at: "APP_CREATED_AT",
    state_dir: "APP_STATE_DIR",
    input_file: "APP_INPUT_FILE",
    events_dir: "APP_EVENTS_DIR",
    mcp_port: "APP_MCP_PORT",
    mcp_token: "APP_MCP_TOKEN",
    sandbox_keys: { measurement: "APP_KEY_MEASUREMENT", subrun: "APP_KEY_SUBRUN" },
    grant_limits: "APP_GRANT_LIMITS",
  },
  sandbox_templates: [{ name: "runner", provider: "safe-pytorchjob", gpus: 1, data_plane: { mode: "open" } }],
  sandbox_roles: { measurement: ["runner"], subrun: ["runner"] },
  events: { dir: "events", format: "cloudevents/v1" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
  restart: { max_restarts: 2, backoff_sec: [10, 30] },
};

export interface ExecRecord { wl: string; command: string; env: Record<string, string>; untracked: boolean }
export interface StartRecord { wl: string; tag: string; env: Record<string, string>; command: string }

export class World {
  clock = T0;
  rec: AppRunRecord;
  /** workload id -> phase */
  workloads = new Map<string, "running" | "terminal" | "absent">();
  /** shared storage */
  files = new Map<string, string>();
  /** `${workload}:${pid}` of live application processes */
  procs = new Set<string>();
  /** processes that exist in a workload but are not the application (a reused pid) */
  strangers = new Set<string>();
  execs: ExecRecord[] = [];
  starts: StartRecord[] = [];
  created: string[] = [];
  stopped: string[] = [];
  /** The fake clock when each sandbox was stopped, in the same order as `stopped`. */
  stoppedAt: number[] = [];
  /** Park every exec matching `when` until `release()` (a Brain that is slow when told to let go). */
  hold: { when: (cmd: string) => boolean; gate: Promise<void>; release: () => void } | null = null;
  patches: Array<{ patch: AppRunPatch; expect?: AppRunState }> = [];
  /** fail the next N execs matching this predicate, as a transport error */
  /** When set, the state directory expansion answers with this exit status. */
  stateDirExit: number | null = null;
  failExec: { left: number; when: (cmd: string) => boolean } | null = null;
  failStore: ((patch: AppRunPatch) => Error | null) | null = null;
  /** SIGTERMs delivered to a live application, by workload. */
  terms: string[] = [];
  /** Keys written by a grant re-issue. Absent means the fixture's original key. */
  grantKeys: AppRunSecrets["grant_keys"] = null;
  /** What the application does on SIGTERM; the default is to die at once without writing `final`. */
  onTerm: ((wl: string) => void) | null = null;
  /** Things that happen when the fake clock reaches a time (an app writing `final` mid-grace). */
  private timers: Array<{ at: number; fn: () => void }> = [];
  private nextWl = 1;
  private nextPid = 100;

  constructor(manifest: AppManifestV1 = MANIFEST, over: Partial<AppRunRecord> = {}) {
    this.rec = {
      run_id: RUN_ID,
      session_id: "sess-1",
      state: "provisioning",
      restarts: 0,
      last_exit: null,
      events_cursor: {},
      state_dir: null,
      sandbox_workload_id: null,
      manifest,
      grant_id: null,
      grant_limits: null,
      grant_templates: null,
      grant_expires_at: null,
      grant_revoked_at: null,
      created_at: new Date(T0).toISOString(),
      input: { image: "img:1", knobs: { mode: "from-input", count: 3 } },
      sandbox_spec: { handle: "app", image: "img:1" } as never,
      workspace_id: "ws-1",
      ...over,
    };
  }

  holdExecs(when: (cmd: string) => boolean): void {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.hold = { when, gate, release };
  }

  now = (): number => this.clock;
  sleep = async (ms: number): Promise<void> => {
    this.clock += ms;
    for (const t of this.timers.filter((x) => x.at <= this.clock)) { this.timers.splice(this.timers.indexOf(t), 1); t.fn(); }
  };

  /** Run `fn` when the fake clock first reaches `atMs` (checked at every sleep). */
  at(atMs: number, fn: () => void): void { this.timers.push({ at: atMs, fn }); }

  /** The application writes `exit.json` and exits. */
  appExits(wl: string, exit?: Record<string, unknown> | string): void {
    for (const key of [...this.procs]) if (key.startsWith(`${wl}:`)) this.procs.delete(key);
    if (exit !== undefined) this.files.set(`${STATE_DIR}/exit.json`, typeof exit === "string" ? exit : JSON.stringify(exit));
  }

  /** SaFE says the workload is gone: its processes with it. */
  killWorkload(wl: string, phase: "terminal" | "absent"): void {
    this.workloads.set(wl, phase);
    for (const key of [...this.procs]) if (key.startsWith(`${wl}:`)) this.procs.delete(key);
  }

  liveWorkload(): string {
    const id = this.rec.sandbox_workload_id;
    if (!id) throw new Error("no sandbox recorded");
    return id;
  }

  alive(wl: string): boolean {
    return [...this.procs].some((k) => k.startsWith(`${wl}:`));
  }

  store: AppRunStore = {
    load: async () => structuredClone(this.rec),
    patch: async (_id, patch, expect) => {
      this.patches.push({ patch, expect });
      const injected = this.failStore?.(patch);
      if (injected) throw injected;
      if (this.rec.state === "ended") throw new AppRunWriteRefused("ended", "ended");
      if (expect && this.rec.state !== expect) throw new AppRunWriteRefused("state_mismatch", this.rec.state);
      const { grant_revoked, grant_keys, ...fields } = patch;
      if (grant_keys) this.grantKeys = grant_keys;
      this.rec = { ...this.rec, ...fields, ...(grant_revoked ? { grant_revoked_at: new Date(this.now()).toISOString() } : {}) } as AppRunRecord;
      return structuredClone(this.rec);
    },
    secrets: async (): Promise<AppRunSecrets> => ({ mcp_token: TOKEN, grant_keys: this.grantKeys ?? { measurement: KEY_M } }),
    putMcp: async (_id, mcp) => { this.mcpRecord = { ...mcp }; },
    deleteMcp: async () => { this.mcpRecord = null; },
  };
  /** What the API holds in `claw_session_app_mcp` for the run. */
  mcpRecord: { url: string; sandbox_session_id: string } | null = null;

  sandbox: AppSandboxOps = {
    ensure: async (run) => {
      const live = [...this.workloads].filter(([, p]) => p === "running").map(([id]) => id);
      if (live.length > 0) {
        const id = live[live.length - 1]!;
        return { instance: this.inst(id), workloadId: id, created: false };
      }
      const id = `wl-${this.nextWl++}`;
      this.workloads.set(id, "running");
      this.created.push(id);
      await this.store.patch(run.runId, { sandbox_workload_id: id });
      return { instance: this.inst(id), workloadId: id, created: true };
    },
    instance: (_run, id) => this.inst(id),
    status: async (inst) => {
      const phase = this.workloads.get(inst.id) ?? "absent";
      return phase === "running"
        ? { running: true, healthy: true, state: "running" }
        : { running: false, healthy: false, state: phase };
    },
    exec: async (inst, command, _timeout, opts) => this.exec(inst.id, command, opts),
    stop: async (inst) => { this.stopped.push(inst.id); this.stoppedAt.push(this.clock); this.killWorkload(inst.id, "terminal"); },
    liveIds: async () => [...this.workloads].filter(([, p]) => p === "running").map(([id]) => id),
    nodeName: async () => "node-7",
  };

  private inst(id: string): SandboxInstance {
    return { provider: "safe-workload", id, sandboxName: id, namespace: "ws-1", handsBaseUrl: "", platformKey: "pk" };
  }

  private async exec(wl: string, command: string, opts?: SandboxExecOptions) {
    this.execs.push({ wl, command, env: { ...(opts?.env ?? {}) }, untracked: opts?.untracked === true });
    if (this.hold?.when(command)) await this.hold.gate;
    if (this.failExec && this.failExec.left > 0 && this.failExec.when(command)) {
      this.failExec.left -= 1;
      throw new Error("transport error");
    }
    if (this.workloads.get(wl) !== "running") throw new Error(`sandbox ${wl} is gone`);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const dir = STATE_DIR;

    if (command.includes("USER_DATA_PATH") && command.includes("printf %s")) {
      return this.stateDirExit === null ? ok(dir) : { exitCode: this.stateDirExit, stdout: "", stderr: "" };
    }
    if (command.includes("base64 -d")) {
      const path = /> '([^']+)'\.tmp/.exec(command)![1]!;
      this.files.set(path, Buffer.from(opts!.env!.CLAW_FILE_B64!, "base64").toString("utf8"));
      return ok();
    }
    if (command.includes("kill -KILL")) {
      const want = /= '([^']*)'/.exec(command)![1]!;
      if (this.files.get(`${dir}/app.sandbox`) !== want) return ok("none\n");
      const pid = this.files.get(`${dir}/app.pid`);
      if (pid !== undefined && this.procs.has(`${wl}:${pid}`)) this.appExits(wl);
      return ok("sent\n");
    }
    if (command.includes("kill -TERM")) {
      const want = /= '([^']*)'/.exec(command)![1]!;
      if (this.files.get(`${dir}/app.sandbox`) !== want) return ok("none\n");
      const pid = this.files.get(`${dir}/app.pid`);
      if (pid !== undefined && this.procs.has(`${wl}:${pid}`)) {
        this.terms.push(wl);
        if (this.onTerm) this.onTerm(wl); else this.appExits(wl);
      }
      return ok("sent\n");
    }
    if (command.includes("echo none")) {
      const want = /!= '([^']*)'/.exec(command)![1]!;
      if (this.files.get(`${dir}/app.sandbox`) !== want) return ok("none\n");
      const pid = this.files.get(`${dir}/app.pid`);
      return ok(pid !== undefined && (this.procs.has(`${wl}:${pid}`) || this.strangers.has(`${wl}:${pid}`)) ? "alive\n" : "dead\n");
    }
    if (command.includes("setsid")) {
      const tag = /printf %s '([^']*)' >app\.sandbox/.exec(command)![1]!;
      const marker = this.files.get(`${dir}/app.sandbox`);
      // Under the start lock: a live process of this sandbox, of any restart generation, is "already".
      if (marker !== undefined && marker.slice(0, marker.lastIndexOf(":")) === tag.slice(0, tag.lastIndexOf(":"))) {
        const pid = this.files.get(`${dir}/app.pid`);
        if (pid !== undefined && this.procs.has(`${wl}:${pid}`)) {
          this.files.set(`${dir}/app.sandbox`, tag);
          return ok("already\n");
        }
      }
      // The start command removes the previous generation's exit record before launching.
      if (command.includes("rm -f 'exit.json'")) this.files.delete(`${dir}/exit.json`);
      this.files.set(`${dir}/app.sandbox`, tag);
      const pid = String(this.nextPid++);
      this.files.set(`${dir}/app.pid`, pid);
      this.procs.add(`${wl}:${pid}`);
      this.starts.push({ wl, tag, env: { ...(opts?.env ?? {}) }, command });
      return ok("started\n");
    }
    if (command.includes("exit.json") && command.includes("cat")) {
      const exit = this.files.get(`${dir}/exit.json`);
      return exit === undefined ? { exitCode: 3, stdout: "", stderr: "" } : ok(exit);
    }
    throw new Error(`the fake does not know this command: ${command.slice(0, 80)}`);
  }
}
