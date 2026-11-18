// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether the release gate's test entry is on (`--driver external`: the gate drives this worker from outside its process).
 * Off unless the environment turns it on, and production never does. It is on only when TEAMS_GATE_ENTRY is exactly "1",
 * GATE_RUN_ID (which only the gate's Job sets) is not empty, and TEAMS_GATE_CONNECTOR_URL is `http://127.0.0.1:<port>`;
 * any other value of TEAMS_GATE_ENTRY stops the worker at start (a typo must not quietly pick a path).
 */
export const PREFIX = "/gate/v1";
export const FILES = "/gate-files/";
export const LOOPBACK = "127.0.0.1";
/** A person linked with `subscribe: false` makes no subscription of their own for a day. */
export const NO_SUBSCRIPTION_SECONDS = 24 * 3600;

export class GateEntryRefused extends Error {
  override name = "GateEntryRefused";
}

export interface GateEntry {
  /** http://127.0.0.1:<port>, the recording Bot Connector of the gate run. */
  readonly connectorUrl: string;
  readonly runId: string;
  /** Where the gate's files are fetched from (the one plain-http place the file fetcher takes). */
  readonly filesPrefix: string;
}

/** `url` as `http://127.0.0.1:<port>`; refused when it is anything else (another host, https, a path, user info). */
export function loopbackUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new GateEntryRefused("TEAMS_GATE_CONNECTOR_URL must be http://127.0.0.1:<port>");
  }
  const port = parsed.port;
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== LOOPBACK ||
    !port ||
    port === "0" ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash ||
    /[@\\\s]/.test(url.trim().replace(/^http:\/\//, ""))
  ) {
    throw new GateEntryRefused("TEAMS_GATE_CONNECTOR_URL must be http://127.0.0.1:<port>");
  }
  return `http://${LOOPBACK}:${port}`;
}

/** The test entry when the environment turns it on; undefined when it does not (TEAMS_GATE_ENTRY unset or empty). */
export function gateEntryFromEnv(env: Readonly<Record<string, string | undefined>>): GateEntry | undefined {
  const raw = env["TEAMS_GATE_ENTRY"] ?? "";
  if (raw === "") return undefined;
  if (raw !== "1") throw new GateEntryRefused(`TEAMS_GATE_ENTRY must be unset or 1, not '${raw}'`);
  const runId = (env["GATE_RUN_ID"] ?? "").trim();
  if (!runId) {
    throw new GateEntryRefused(
      "TEAMS_GATE_ENTRY=1 needs GATE_RUN_ID: the test entry runs only in a release gate's Job",
    );
  }
  const connectorUrl = loopbackUrl(env["TEAMS_GATE_CONNECTOR_URL"] ?? "");
  return { connectorUrl, runId, filesPrefix: connectorUrl + FILES };
}
