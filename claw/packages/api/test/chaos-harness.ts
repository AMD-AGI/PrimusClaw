// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The pieces of a real Claw deployment, on one machine, for rolling-restart
 * tests: Postgres (a fresh database on the server DATABASE_URL names), a
 * JetStream-enabled nats-server, API and Brain as the processes production
 * runs (`node --import tsx src/index.ts`), an OpenAI-compatible model that
 * answers slowly enough for a run to be in flight when something restarts,
 * and a TCP front that plays kube-proxy: each new connection goes to a ready
 * endpoint, and an endpoint taken out of rotation keeps the connections it
 * already has.
 *
 * Not a test file (no `.test.ts`): rolling-restart-chaos.test.ts drives it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGES = join(HERE, "..", "..");
const TSX = import.meta.resolve("tsx");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms: number, everyMs = 250): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** A child process with its log on disk. Only processes this harness spawned are ever signalled. */
export class Proc {
  readonly child: ChildProcess;
  exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly done: Promise<void>;

  constructor(readonly name: string, cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string }) {
    const out = createWriteStream(opts.log, { flags: "a" });
    this.child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout!.pipe(out);
    this.child.stderr!.pipe(out);
    this.done = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => { this.exited = { code, signal }; resolve(); });
    });
    this.log = opts.log;
  }
  readonly log: string;

  get pid(): number { return this.child.pid!; }
  get alive(): boolean { return this.exited === null; }
  signal(sig: NodeJS.Signals): void { if (this.alive) this.child.kill(sig); }
  async stop(sig: NodeJS.Signals = "SIGTERM", ms = 90_000): Promise<void> {
    this.signal(sig);
    await Promise.race([this.done, sleep(ms)]);
    if (this.alive) { this.child.kill("SIGKILL"); await this.done; }
  }
  wait(): Promise<void> { return this.done; }
  tail(lines = 40): string {
    try { return readFileSync(this.log, "utf8").split("\n").slice(-lines).join("\n"); } catch { return ""; }
  }
  grep(re: RegExp): string[] {
    try { return readFileSync(this.log, "utf8").split("\n").filter((l) => re.test(l)); } catch { return []; }
  }
}

/** kube-proxy, in miniature: a connection goes to one ready endpoint and stays there. */
export class Front {
  readonly endpoints = new Map<string, { port: number; ready: boolean }>();
  private server!: net.Server;
  port = 0;
  connections = 0;

  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      const ready = [...this.endpoints.values()].filter((e) => e.ready);
      if (ready.length === 0) { client.destroy(); return; }
      const target = ready[this.connections++ % ready.length]!;
      const upstream = net.connect(target.port, "127.0.0.1");
      client.pipe(upstream).pipe(client);
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on("error", close);
      upstream.on("error", close);
      client.on("close", close);
      upstream.on("close", close);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
  }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  set(name: string, port: number, ready: boolean): void { this.endpoints.set(name, { port, ready }); }
  setReady(name: string, ready: boolean): void { const e = this.endpoints.get(name); if (e) e.ready = ready; }
  async close(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
}

/**
 * An OpenAI-compatible chat endpoint that streams its answer over `holdMs` (as it
 * was when the call began), so a run is mid-turn for that long. Counts calls, so a test can tell a turn that
 * was resumed (two calls) from one that was never interrupted (one).
 */
export class FakeModel {
  private server!: http.Server;
  port = 0;
  calls = 0;
  completed = 0;
  holdMs = 8_000;

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const j = body ? JSON.parse(body) as { stream?: boolean; model?: string } : {};
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", model: j.model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      const n = ++this.calls;
      // Read once per call: a test that shortens the next call (the one a resumed turn makes) must not hurry the call
      // in flight to its end before the disruption it is about to cause.
      const holdMs = this.holdMs;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: `c${n}`, object: "chat.completion.chunk", model: j.model };
      chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
      const steps = 10;
      for (let i = 0; i < steps; i++) {
        await sleep(holdMs / steps);
        if (res.destroyed) return;
        chunk({ ...base, choices: [{ index: 0, delta: { content: `part${i} ` } }] });
      }
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      chunk({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
      res.end("data: [DONE]\n\n");
      this.completed++;
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export interface Cluster {
  dir: string;
  dbUrl: string;
  db: pg.Client;
  nats: Proc;
  natsPort: number;
  front: Front;
  model: FakeModel;
  env: NodeJS.ProcessEnv;
  apis: Map<string, { proc: Proc; port: number }>;
  brains: Map<string, Proc>;
  startApi(name: string): Promise<void>;
  /** A rolling-update step: new pod ready, old pod out of endpoints, preStop, SIGTERM, wait for exit. */
  rollApi(oldName: string, newName: string, preStopMs?: number): Promise<void>;
  startBrain(name: string): Promise<Proc>;
  close(): Promise<void>;
  logs(): string;
}

export async function startCluster(opts: { natsServer: string; adminDbUrl: string; env?: NodeJS.ProcessEnv }): Promise<Cluster> {
  const dir = mkdtempSync(join(tmpdir(), "claw-chaos-"));
  const dbName = `claw_chaos_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: opts.adminDbUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const u = new URL(opts.adminDbUrl);
  u.pathname = `/${dbName}`;
  const dbUrl = u.toString();
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();

  const natsPort = await freePort();
  const nats = new Proc("nats", opts.natsServer, ["-js", "-a", "127.0.0.1", "-p", String(natsPort), "-sd", join(dir, "js")], {
    cwd: dir, env: { PATH: process.env.PATH }, log: join(dir, "nats.log"),
  });
  await until("nats", async () => readFileSync(nats.log, "utf8").includes("Server is ready"), 20_000);

  const front = new Front();
  await front.start();
  const model = new FakeModel();
  await model.start();

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? dir,
    NO_PROXY: "*",
    APP_ENV: "dev",
    CLAW_INSECURE_DEV_AUTH: "1",
    DATABASE_URL: dbUrl,
    NATS_URL: `nats://127.0.0.1:${natsPort}`,
    NATS_REPLICAS: "1",
    AUTH_INTERNAL_TOKEN: "chaos-internal-token",
    USER_ENV_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BRAIN_CHECKPOINT_KEY: randomBytes(32).toString("base64"),
    OPENAI_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    OPENAI_API_KEY: "sk-chaos",
    LLM_API_STYLE: "openai",
    DEFAULT_MODEL: "chaos-model",
    INTERNAL_BACKEND_URL: front.url,
    DOTENV_CONFIG_QUIET: "true",
    DOTENV_CONFIG_PATH: join(dir, "no-such.env"),
    // A deployment without the chart's preStop: the test plays that part.
    SHUTDOWN_DELAY_MS: "0",
    ...opts.env,
  };

  const apis = new Map<string, { proc: Proc; port: number }>();
  const brains = new Map<string, Proc>();

  const cluster: Cluster = {
    dir, dbUrl, db, nats, natsPort, front, model, env, apis, brains,
    async startApi(name) {
      const port = await freePort();
      const proc = new Proc(name, process.execPath, ["--import", TSX, "src/index.ts"], {
        cwd: join(PACKAGES, "api"), env: { ...env, API_PORT: String(port) }, log: join(dir, `${name}.log`),
      });
      apis.set(name, { proc, port });
      await until(`${name} ready`, async () => {
        if (!proc.alive) throw new Error(`${name} exited: ${proc.tail()}`);
        const r = await fetch(`http://127.0.0.1:${port}/ready`);
        return r.ok;
      }, 120_000, 500);
      front.set(name, port, true);
    },
    async rollApi(oldName, newName, preStopMs = 1_000) {
      await cluster.startApi(newName);
      front.setReady(oldName, false);
      await sleep(preStopMs);
      await apis.get(oldName)!.proc.stop("SIGTERM");
    },
    async startBrain(name) {
      const port = await freePort();
      const proc = new Proc(name, process.execPath, ["--import", TSX, "src/index.ts"], {
        cwd: join(PACKAGES, "brain"),
        env: {
          ...env, BRAIN_ID: name, POD_NAME: name, EXECUTOR_PORT: String(port), EXECUTOR_HOST: "127.0.0.1",
          BRAIN_SANDBOX_PRESTART: "false", BRAIN_LAZY_SANDBOX: "true", CLAIM_NEXT_IDLE_MS: "500",
        },
        log: join(dir, `${name}.log`),
      });
      brains.set(name, proc);
      await until(`${name} ready`, async () => {
        if (!proc.alive) throw new Error(`${name} exited: ${proc.tail()}`);
        return proc.grep(/"msg":"brain\.ready"/).length > 0;
      }, 120_000, 500);
      return proc;
    },
    async close() {
      for (const b of brains.values()) await b.stop("SIGKILL", 5_000);
      for (const a of apis.values()) await a.proc.stop("SIGKILL", 5_000);
      nats.signal("SIGCONT");
      await nats.stop("SIGKILL", 5_000);
      await front.close();
      await model.close();
      await db.end().catch(() => {});
      const a = new pg.Client({ connectionString: opts.adminDbUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await a.end();
      if (!process.env.CLAW_CHAOS_KEEP_LOGS) rmSync(dir, { recursive: true, force: true });
    },
    logs() {
      const parts = [...apis.values()].map((a) => `--- ${a.proc.name}\n${a.proc.tail(30)}`);
      for (const b of brains.values()) parts.push(`--- ${b.name}\n${b.tail(40)}`);
      return parts.join("\n");
    },
  };
  return cluster;
}

/** Through the front, as a browser or a Teams bot would arrive. */
export async function api<T = Record<string, unknown>>(c: Cluster, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${c.front.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export interface RunRow {
  task_id: string; status: string; failure_reason: string | null; claim_count: number;
  completed_at: Date | null; started_at: Date | null; lease_owner: string | null;
}

export async function runRow(c: Cluster, taskId: string): Promise<RunRow | null> {
  const r = await c.db.query("SELECT task_id, status, failure_reason, claim_count, completed_at, started_at, lease_owner FROM claw_tasks WHERE task_id = $1", [taskId]);
  return (r.rows[0] as RunRow | undefined) ?? null;
}

export async function eventCounts(c: Cluster, sessionId: string): Promise<Record<string, number>> {
  const r = await c.db.query("SELECT event, count(*)::int AS n FROM claw_session_events WHERE session_id = $1 GROUP BY 1", [sessionId]);
  return Object.fromEntries(r.rows.map((row: { event: string; n: number }) => [row.event, row.n]));
}

/** Start one chat turn; returns ids once the API has accepted it. */
export async function startTurn(c: Cluster, prompt: string): Promise<{ sessionId: string; runId: string }> {
  const s = await api<{ data: { session_id: string } }>(c, "POST", "/v1/sessions", {});
  const m = await api<{ run_id: string }>(c, "POST", `/v1/sessions/${s.data.session_id}/messages`, { content: prompt });
  return { sessionId: s.data.session_id, runId: m.run_id };
}

export async function waitTerminal(c: Cluster, runId: string, ms: number): Promise<RunRow> {
  return until(`run ${runId} terminal`, async () => {
    const row = await runRow(c, runId);
    return row && ["completed", "failed", "cancelled"].includes(row.status) ? row : null;
  }, ms, 250);
}
