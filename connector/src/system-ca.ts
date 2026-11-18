// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Trusting the certificate authorities this machine trusts.
 *
 * Node.js trusts only its own bundled Mozilla list unless told otherwise (NODE_USE_SYSTEM_CA=1, --use-system-ca), so a
 * Claw behind a company CA that the operating system trusts (curl works) failed every connection of a fresh install.
 * The connector now adds the system store to Node's defaults itself, before it opens any connection: the bundled list
 * and NODE_EXTRA_CA_CERTS stay trusted, the system store is added to them. NODE_USE_SYSTEM_CA=0 turns this off.
 *
 * Node.js 22.19+ / 24.5+ can do this from inside the process (tls.getCACertificates + tls.setDefaultCACertificates).
 * An older Node.js cannot; the outcome says so, and doctor names what to do there.
 */
import tls from "node:tls";

export type SystemCaOutcome =
  /** The system store was added to Node's default CAs; `count` certificates came from it. */
  | { kind: "applied"; count: number }
  /** The user turned it off (NODE_USE_SYSTEM_CA=0). */
  | { kind: "disabled" }
  /** This Node.js cannot change its default CAs from inside (older than 22.19 / 24.5). */
  | { kind: "unsupported"; flag: boolean }
  /** The system store answered with no certificates, or could not be read. */
  | { kind: "empty"; error?: string };

/** The part of node:tls this uses, so a test can stand in for a Node.js without the calls. */
export interface TlsCaApi {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

let last: SystemCaOutcome | null = null;

/** What {@link trustSystemCAs} did in this process, or null when it has not run (a test calling `main` directly). */
export const systemCaOutcome = (): SystemCaOutcome | null => last;

/**
 * Add this machine's CA store to the CAs Node.js trusts by default. Call it before the first TLS connection: a
 * connection already made (and sessions it cached) keeps the CAs it had.
 */
export function trustSystemCAs(env: NodeJS.ProcessEnv, api: TlsCaApi = tls as unknown as TlsCaApi,
  allowed: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): SystemCaOutcome {
  last = decide(env, api, allowed);
  return last;
}

function decide(env: NodeJS.ProcessEnv, api: TlsCaApi, allowed: ReadonlySet<string>): SystemCaOutcome {
  if (env.NODE_USE_SYSTEM_CA === "0") return { kind: "disabled" };
  const get = api.getCACertificates;
  const set = api.setDefaultCACertificates;
  if (typeof get !== "function" || typeof set !== "function") return { kind: "unsupported", flag: allowed.has("--use-system-ca") };
  try {
    const system = get.call(api, "system");
    if (!system.length) return { kind: "empty" };
    // "default" is what Node.js trusts now: the bundled list (or OpenSSL's), NODE_EXTRA_CA_CERTS, and the system store when
    // NODE_USE_SYSTEM_CA=1 already added it. Node.js removes the duplicates.
    set.call(api, [...get.call(api, "default"), ...system]);
    return { kind: "applied", count: system.length };
  } catch (e) {
    return { kind: "empty", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The environment the processes the connector starts inherit: NODE_USE_SYSTEM_CA=1, so a Node.js program among them (an
 * adapter, npm installing one, a supervised run) trusts the same store. Only when the connector itself added it, and
 * never over a value the user set.
 */
export function inheritSystemCa(env: NodeJS.ProcessEnv, outcome: SystemCaOutcome): void {
  if (outcome.kind === "applied" && env.NODE_USE_SYSTEM_CA === undefined) env.NODE_USE_SYSTEM_CA = "1";
}
