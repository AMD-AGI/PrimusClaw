// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a process spawned on the model's behalf runs as, and what it can see.
 *
 * Children inherited Hands' own operating-system identity and its whole
 * environment, which put three things inside the model's reach: the internal
 * bearer token that authorises the routes ending other runs' work, the record
 * subtree and epoch marker every destroy gate reads, and -- because one sandbox
 * serves several runs under one identity -- the other runs' processes, listable
 * through the process filesystem and signallable by group.
 *
 * The boundary is a property of the spawn, in three parts: an unprivileged
 * identity of its own per *(owner scope, run identity)* pair, a process view
 * that cannot observe another pair's processes, and an environment built from
 * an allow-list rather than passed through. Foreground and background share
 * this one path, so neither is a way round the others.
 *
 * The environment binds unconditionally -- it needs nothing of the sandbox. The
 * identity and the process view are properties the sandbox has to provide, and
 * a sandbox declaring an identity range is declaring that it does: from there
 * a missing process view refuses the spawn rather than serving it under Hands'
 * identity. A sandbox that declares no range provides no such boundary and is
 * reported as unenforced on every spawn, which is what an operator reads to
 * know the isolation baseline has not reached this deployment yet.
 */

import { readFileSync } from "node:fs";
import { APPLIED_ENV_KEYS } from "./env-file.js";

/** Raised where the boundary cannot be placed. Never downgraded to a warning. */
export class ChildPrivilegeUnavailable extends Error {}

export interface ChildPrivilege {
  /** Absent where the sandbox declares no range; the spawn keeps Hands'. */
  uid?: number;
  gid?: number;
  env: NodeJS.ProcessEnv;
}

/**
 * What this sandbox can actually provide.
 *
 * Read through a seam so a test can assert both directions of the refusal.
 * Production binds nothing, and no production behaviour is conditional on
 * whether a test has.
 */
export interface SandboxIsolation {
  /** The identity range this sandbox allocates model-issued processes from. */
  identityRange(): { min: number; max: number } | null;
  /** Whether a model-issued process is prevented from observing another's. */
  partitionsProcessView(): boolean;
}

let isolation: SandboxIsolation | null = null;

/** Test-only. No production path sets this. */
export function bindSandboxIsolation(next: SandboxIsolation | null): void {
  isolation = next;
  allocated.clear();
  nextIdentity = null;
}

const PRODUCTION_ISOLATION: SandboxIsolation = {
  identityRange(): { min: number; max: number } | null {
    // Assuming another identity needs the privilege to do so; without it the
    // range is not one this process can allocate from.
    if (process.getuid?.() !== 0) return null;
    const min = Number(process.env.HANDS_CHILD_UID_MIN);
    const max = Number(process.env.HANDS_CHILD_UID_MAX);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) return null;
    return { min, max };
  },
  partitionsProcessView(): boolean {
    // `hidepid` at its strict setting is what makes another identity's entries
    // unlistable; a private process-identifier namespace does as well, and
    // shows up the same way -- a mount this process cannot see outside itself
    // through.
    try {
      return readFileSync("/proc/self/mountinfo", "utf8")
        .split("\n")
        .some((line) => / \/proc /.test(line) && /hidepid=(2|invisible)/.test(line));
    } catch {
      return false;
    }
  },
};

function sandboxIsolation(): SandboxIsolation {
  return isolation ?? PRODUCTION_ISOLATION;
}

const allocated = new Map<string, number>();
let nextIdentity: number | null = null;

/**
 * The identity this pair's processes run as, held for the sandbox's life.
 *
 * Allocated rather than derived from a hash of the pair: two pairs colliding on
 * a derived value would share one identity and one signal authority, which is
 * the separation this exists for. Exhausting the range refuses the spawn.
 */
function identityFor(owner: string, run: string, range: { min: number; max: number }): number {
  const key = `${owner} ${run}`;
  const held = allocated.get(key);
  if (held !== undefined) return held;

  nextIdentity ??= range.min;
  if (nextIdentity > range.max) {
    throw new ChildPrivilegeUnavailable(
      `this sandbox has no unprivileged identity left for a new run (range ${range.min}-${range.max})`,
    );
  }
  const id = nextIdentity++;
  allocated.set(key, id);
  return id;
}

/**
 * Names a model-issued process may see, and nothing else.
 *
 * Built up from the workspace-facing configuration rather than filtered down
 * from this process's environment: a deny list is a promise to remember every
 * future secret, and the one that matters -- the internal bearer token -- is
 * set by the launch command, so it is present in every child by default under
 * any list that starts from the parent's environment.
 */
const WORKSPACE_FACING = [
  "PATH", "HOME", "SHELL", "TERM", "TZ", "LANG", "LC_ALL", "PWD", "USER", "LOGNAME",
];

export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of WORKSPACE_FACING) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The per-request environment Brain wrote for this session: the user's own
  // configuration and credentials for their own work, which is what a command
  // is run to use. Hands' own configuration is not in that set -- the env file
  // never applies it -- so the token is not reachable through here either.
  for (const key of APPLIED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * The identity, process view and environment for one pair's next spawn.
 *
 * @throws ChildPrivilegeUnavailable where the sandbox declares an identity
 * range and cannot partition the process view, or has no identity left.
 */
export function resolveChildPrivilege(owner: string, run: string): ChildPrivilege {
  const sandbox = sandboxIsolation();
  const range = sandbox.identityRange();
  if (!range) {
    reportUnenforced();
    return { env: childEnvironment() };
  }
  // Declaring a range is declaring the boundary. Half of it is not a weaker
  // boundary, it is none: one shared identity leaves the runs sharing a sandbox
  // able to enumerate and signal one another's processes.
  if (!sandbox.partitionsProcessView()) {
    throw new ChildPrivilegeUnavailable(
      "this sandbox cannot keep one run's processes out of another's view, "
      + "so the command was not run",
    );
  }
  const id = identityFor(owner, run, range);
  return { uid: id, gid: id, env: childEnvironment() };
}

/**
 * Say so, every time, that this sandbox runs the model's commands under Hands'
 * own identity.
 *
 * Not a one-off warning at startup: an operator reading a shell log has to be
 * able to see which spawns were served without the boundary, and a count that
 * stops after the first says nothing about the rest.
 */
function reportUnenforced(): void {
  console.log(JSON.stringify({
    level: 40,
    time: Date.now(),
    name: "hands-shell",
    msg: "shell.child_identity_unenforced",
    reason: "no_identity_range_declared",
  }));
}
