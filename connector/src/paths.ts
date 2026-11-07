// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Where the connector keeps its files. */
import os from "node:os";
import path from "node:path";

export interface Dirs {
  /** agents.toml and the credentials file. */
  config: string;
  /** Connector identity, session map, outbox, audit log, adapter logs, child registry. */
  state: string;
}

/**
 * `CLAW_CONNECTOR_HOME` puts everything under one directory (tests, containers);
 * otherwise the XDG locations, with their usual defaults.
 */
export function resolveDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Dirs {
  const one = env.CLAW_CONNECTOR_HOME?.trim();
  if (one) return { config: path.join(one, "config"), state: path.join(one, "state") };
  const cfg = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const st = env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state");
  return { config: path.join(cfg, "claw-connector"), state: path.join(st, "claw-connector") };
}

export const configFile = (d: Dirs) => path.join(d.config, "agents.toml");
export const credentialsFile = (d: Dirs) => path.join(d.config, "credentials.json");
export const identityFile = (d: Dirs) => path.join(d.state, "connector.json");
export const sessionsFile = (d: Dirs) => path.join(d.state, "sessions.json");
export const childrenFile = (d: Dirs) => path.join(d.state, "children.json");
export const pidFile = (d: Dirs) => path.join(d.state, "connector.pid");
export const pauseFile = (d: Dirs) => path.join(d.state, "paused");
/** Written by `stop` for the run it is about to end: only that run ends with exit 0, which a supervisor does not restart. */
export const stopRequestFile = (d: Dirs) => path.join(d.state, "stop-requested.json");
export const auditFile = (d: Dirs) => path.join(d.state, "audit.jsonl");
export const outboxDir = (d: Dirs) => path.join(d.state, "outbox");
export const logDir = (d: Dirs) => path.join(d.state, "logs");
export const disconnectsFile = (d: Dirs) => path.join(d.state, "disconnects.jsonl");
export const needsLoginFile = (d: Dirs) => path.join(d.state, "needs-login.json");
export const supervisorPidFile = (d: Dirs) => path.join(d.state, "supervisor.pid");
export const runLogFile = (d: Dirs) => path.join(d.state, "run.log");
export const keepaliveFile = (d: Dirs) => path.join(d.state, "keepalive.sh");
export const serviceFile = (d: Dirs) => path.join(d.state, "service.json");
