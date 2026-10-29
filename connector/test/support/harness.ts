// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A connector wired to a FakeClaw and a fake ACP adapter, on a temporary home. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClawClient } from "../../src/claw-client.js";
import { parseConfig, type ConnectorConfig } from "../../src/config.js";
import { Connector, type ConnectorTiming, type RunResult } from "../../src/connector.js";
import { KeyTokenProvider, type TokenProvider } from "../../src/credentials.js";
import { fileAudit } from "../../src/audit.js";
import { auditFile, resolveDirs, type Dirs } from "../../src/paths.js";
import { silentLogger } from "../../src/util.js";
import { FakeClaw } from "./fake-claw.js";

export const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-adapter.mjs");

export const tmpdir = (p = "cc-"): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

export const FAST: Partial<ConnectorTiming> = {
  heartbeatMs: 150, watchdogMs: 700, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 150, pausePollMs: 40,
  idleMs: 60_000, permissionTtlMs: 60_000, modeConfirmMs: 250,
};

export interface HarnessOptions {
  env?: Record<string, string>;
  /** Extra TOML for the agent table, and for the top of the file. */
  agentToml?: string;
  topToml?: string;
  timing?: Partial<ConnectorTiming>;
  claw?: FakeClaw;
  home?: string;
  work?: string;
  token?: string;
  tokens?: TokenProvider;
  start?: boolean;
}

export class Harness {
  claw!: FakeClaw;
  connector!: Connector;
  config!: ConnectorConfig;
  dirs!: Dirs;
  work!: string;
  running: Promise<RunResult> | null = null;
  fakeLog = "";

  static async create(o: HarnessOptions = {}): Promise<Harness> {
    const h = new Harness();
    h.claw = o.claw ?? (await FakeClaw.start());
    h.dirs = resolveDirs({ CLAW_CONNECTOR_HOME: o.home ?? tmpdir() } as NodeJS.ProcessEnv);
    h.work = o.work ?? tmpdir("cc-work-");
    h.fakeLog = path.join(h.dirs.state, "fake-adapter.log");
    fs.mkdirSync(h.dirs.state, { recursive: true });
    const env = { FAKE_LOG: h.fakeLog, ...(o.env ?? {}) };
    const envToml = Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
    h.config = parseConfig(`${o.topToml ?? ""}
[[agents]]
id = "fake"
kind = "example"
name = "Fake agent"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
safe_modes = ["default", "plan"]
roots = [${JSON.stringify(h.work)}]
${o.agentToml ?? ""}
[agents.env]
${envToml}
`, { hostname: "test-box" });
    h.connect(o);
    if (o.start !== false) h.start();
    return h;
  }

  /** (Re)build the connector object on the same home, as after a restart. */
  connect(o: HarnessOptions = {}): void {
    const client = new ClawClient({ server: this.claw.url, tokens: o.tokens ?? new KeyTokenProvider(o.token ?? "good-token"), requestTimeoutMs: 3000 });
    this.connector = new Connector({
      config: this.config, dirs: this.dirs, client, server: this.claw.url, audit: fileAudit(auditFile(this.dirs)), log: silentLogger,
      version: "test", timing: { ...FAST, ...(o.timing ?? {}) },
    });
  }

  start(): Promise<RunResult> {
    this.running = this.connector.run();
    return this.running;
  }

  async online(): Promise<void> {
    await this.claw.until("the command stream to be open and a heartbeat to arrive", () => this.claw.online && this.claw.heartbeats.length > 0);
  }

  async stop(): Promise<RunResult> {
    this.connector.stop();
    return (await this.running) ?? "stopped";
  }

  async close(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.claw.close();
  }

  /** A session created and started, resolved when `session_started` or `session_closed` arrives. */
  async newSession(cwd: string = this.work, mode?: string): Promise<string> {
    await this.online();
    const sid = this.claw.newSession("fake", cwd, mode);
    await this.claw.until("session_started or session_closed", () => this.claw.eventsOf(sid).some((e) => e.type === "session_started" || e.type === "session_closed"));
    return sid;
  }

  prompt(sid: string, text: string, extra: Record<string, unknown> = {}): number {
    return this.claw.issue("prompt", sid, { text, ...extra });
  }

  turnEnds(sid: string) { return this.claw.eventsOf(sid, "turn_end"); }
  async turnEnd(sid: string, n = 1) { return this.claw.until(`turn_end #${n}`, () => this.turnEnds(sid)[n - 1]); }

  async permission(sid: string, n = 1) {
    return this.claw.until(`permissionRequest #${n}`, () => this.claw.eventsOf(sid, "permissionRequest").filter((e) => !e.data.resent)[n - 1]);
  }

  decide(sid: string, actionId: string, optionId: string): number {
    return this.claw.issue("decision", sid, { action_id: actionId, option_id: optionId, by: "user-1", cmd_id: `dec:${sid}:${actionId}` });
  }

  /** What the fake adapter logged: one object per line. */
  adapterLog(): any[] {
    try { return fs.readFileSync(this.fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  audit(): any[] {
    try { return fs.readFileSync(auditFile(this.dirs), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  messages(sid: string): string[] {
    return this.claw.eventsOf(sid, "agent_message_chunk").map((e) => e.data.update.content.text);
  }
}
