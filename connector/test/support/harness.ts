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
export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");

export const tmpdir = (p = "cc-"): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

export const FAST: Partial<ConnectorTiming> = {
  heartbeatMs: 150, watchdogMs: 700, batchMs: 15, backoffMinMs: 20, backoffMaxMs: 150, pausePollMs: 40,
  idleMs: 60_000, permissionTtlMs: 60_000, modeConfirmMs: 250,
};

/** An agent made from the claude-attach preset, with a stand-in `claude` command and a Claude config directory of its own. */
export interface AttachOptions {
  /** What the adapter's `session/list` answers. */
  sessions: Array<{ sessionId: string; cwd: string; title: string; updatedAt: string }>;
  /** What `claude agents --json` answers; change it later with `attach.setLive`. */
  live?: Array<Record<string, unknown>>;
  /** ok | garbage | fail | hang | notlist (see fake-claude.mjs). */
  cliMode?: string;
  /** Use this command instead of the stand-in. */
  cli?: string;
}

export interface HarnessOptions {
  attach?: AttachOptions;
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
  /** For an attach agent: its Claude config directory, and the files the stand-in command reads and writes. */
  attachDir = "";
  liveFile = "";
  cliLog = "";

  static async create(o: HarnessOptions = {}): Promise<Harness> {
    const h = new Harness();
    h.claw = o.claw ?? (await FakeClaw.start());
    h.dirs = resolveDirs({ CLAW_CONNECTOR_HOME: o.home ?? tmpdir() } as NodeJS.ProcessEnv);
    h.work = o.work ?? tmpdir("cc-work-");
    h.fakeLog = path.join(h.dirs.state, "fake-adapter.log");
    fs.mkdirSync(h.dirs.state, { recursive: true });
    let attachToml = "";
    const attachEnv: Record<string, string> = {};
    if (o.attach) {
      h.attachDir = tmpdir("cc-claude-");
      h.liveFile = path.join(h.attachDir, "live.json");
      h.cliLog = path.join(h.attachDir, "cli.log");
      fs.writeFileSync(h.liveFile, JSON.stringify(o.attach.live ?? []));
      const wrapper = path.join(h.attachDir, "claude");
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`, { mode: 0o755 });
      attachToml = `preset = "claude-attach"\nattach_cli = ${JSON.stringify(o.attach.cli ?? wrapper)}`;
      Object.assign(attachEnv, {
        CLAUDE_CONFIG_DIR: h.attachDir, FAKE_CLAUDE_LIVE: h.liveFile, FAKE_CLAUDE_LOG: h.cliLog, FAKE_CLAUDE_MODE: o.attach.cliMode ?? "ok",
        FAKE_SESSIONS: JSON.stringify(o.attach.sessions),
      });
    }
    const env = { FAKE_LOG: h.fakeLog, ...attachEnv, ...(o.env ?? {}) };
    const envToml = Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
    h.config = parseConfig(`${o.topToml ?? ""}
[[agents]]
id = "fake"
${o.attach ? "" : 'kind = "example"'}
name = "Fake agent"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
safe_modes = ["default", "plan"]
roots = [${JSON.stringify(h.work)}]
${attachToml}
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

  /** `session.new` naming an existing session, resolved when `session_started` or `session_closed` arrives. */
  async attach(ref: string | undefined, cwd: string = this.work, extra: Record<string, unknown> = {}): Promise<string> {
    await this.online();
    const sid = this.claw.newSession("fake", cwd, undefined, ref === undefined ? extra : { resume_ref: ref, ...extra });
    await this.claw.until("session_started or session_closed", () => this.claw.eventsOf(sid).some((e) => e.type === "session_started" || e.type === "session_closed"));
    return sid;
  }

  setLive(entries: Array<Record<string, unknown>>): void {
    fs.writeFileSync(this.liveFile, JSON.stringify(entries));
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
