// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a process spawned on the model's behalf runs as, and what it can see.
 *
 * The boundary is a property of the spawn, in three parts: an unprivileged
 * identity of its own per *(owner scope, run identity)* pair, a process view
 * that cannot observe another pair's processes, and an environment that is the
 * container's own minus this service's configuration and credentials.
 * Foreground and background share this one path, so neither is a way round
 * the others.
 *
 * The environment binds unconditionally; it needs nothing of the sandbox. The
 * other two are the sandbox's to provide, and declaring an identity range is
 * declaring that it does -- from there a missing process view, or a process
 * unable to assume an identity, refuses the spawn. A sandbox declaring no range
 * is reported as unenforced on every spawn, which is what says the isolation
 * baseline has not reached this deployment.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serviceOwned } from "./env-file.js";
import { currentEpoch, stateRoot } from "./shell-records.js";

/** Raised where the boundary cannot be placed. Never downgraded to a warning. */
export class ChildPrivilegeUnavailable extends Error {}

export interface ChildPrivilege {
  /** Absent where the sandbox declares no range; the spawn keeps Hands'. */
  uid?: number;
  gid?: number;
  env: NodeJS.ProcessEnv;
}

/** Read through a seam so a test can assert both directions of the refusal. */
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
  allocated = null;
}

const PRODUCTION_ISOLATION: SandboxIsolation = {
  identityRange(): { min: number; max: number } | null {
    const min = Number(process.env.HANDS_CHILD_UID_MIN);
    const max = Number(process.env.HANDS_CHILD_UID_MAX);
    if (process.env.HANDS_CHILD_UID_MIN === undefined
      && process.env.HANDS_CHILD_UID_MAX === undefined) return null;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
      throw new ChildPrivilegeUnavailable(
        `HANDS_CHILD_UID_MIN/MAX name no usable identity range (${String(process.env.HANDS_CHILD_UID_MIN)}`
        + `-${String(process.env.HANDS_CHILD_UID_MAX)})`,
      );
    }
    // A declared range this process cannot assume from is a boundary the
    // deployment asked for and the runtime cannot give. Falling back to Hands'
    // own identity there is the silent unenforcement the declaration rules out.
    if (process.getuid?.() !== 0) {
      throw new ChildPrivilegeUnavailable(
        "this sandbox declares a child identity range but does not run privileged enough to assume one",
      );
    }
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

const ALLOCATION_FILE = "child-identities.json";
let allocated: Map<string, number> | null = null;

/**
 * The identity this pair's processes run as, held for the sandbox's life.
 *
 * Durable, not process-local: an in-memory table restarts the allocation and
 * hands a live child's identity to a different pair. Allocated rather than
 * hashed, since a hash collision would share one identity, and with it one
 * signal authority, between two runs.
 */
function identityFor(owner: string, run: string, range: { min: number; max: number }): number {
  const table = allocationTable();
  const key = `${owner}\u0000${run}`;
  const held = table.get(key);
  if (held !== undefined) return held;

  const taken = new Set(table.values());
  for (let id = range.min; id <= range.max; id++) {
    if (taken.has(id)) continue;
    table.set(key, id);
    persistAllocations(table);
    return id;
  }
  throw new ChildPrivilegeUnavailable(
    `this sandbox has no unprivileged identity left for a new run (range ${range.min}-${range.max})`,
  );
}

/**
 * Whether an assignment made now can be read back after a restart.
 *
 * The table lives beside the durable records, in a state area the epoch mint
 * creates before anything can be started -- fatally, if it cannot. A process
 * that filed no epoch has no records either, so it has nothing to be consistent
 * with across a restart and nothing to write beside.
 */
function allocationIsDurable(): boolean {
  return currentEpoch() !== null && existsSync(stateRoot());
}

/**
 * @throws ChildPrivilegeUnavailable where the table exists and cannot be used.
 * A table read as empty after a failed read hands a live process's identity to
 * another pair, which is the separation this file exists to keep.
 */
function allocationTable(): Map<string, number> {
  if (allocated) return allocated;
  if (!allocationIsDurable()) {
    allocated = new Map();
    return allocated;
  }
  let raw: string;
  try {
    raw = readFileSync(join(stateRoot(), ALLOCATION_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ChildPrivilegeUnavailable(
        `the child identity table could not be read (${(e as Error).message}), `
        + "so an assignment now could take one a running process already holds",
      );
    }
    allocated = new Map();
    return allocated;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ChildPrivilegeUnavailable(
      `the child identity table is unreadable (${(e as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChildPrivilegeUnavailable("the child identity table is not a table");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.every(([, v]) => Number.isInteger(v))) {
    throw new ChildPrivilegeUnavailable("the child identity table holds a value that is not an identity");
  }
  allocated = new Map(entries as Array<[string, number]>);
  return allocated;
}

function persistAllocations(table: Map<string, number>): void {
  if (!allocationIsDurable()) return;
  const dir = stateRoot();
  const staged = join(dir, `${ALLOCATION_FILE}.staged`);
  writeFileSync(staged, JSON.stringify(Object.fromEntries(table)), { mode: 0o600 });
  renameSync(staged, join(dir, ALLOCATION_FILE));
}

/**
 * Names Hands passes on although it owns them.
 *
 * Everything else a command sees is the container's environment: what the
 * image declares (`ENV` in its config), what the pod spec sets, and what
 * Kubernetes adds, the same environment `kubectl exec` gives. A command run
 * for the model is work in that image, and the image's settings are how it is
 * meant to be run -- library search paths, toolchain locations, runtime tuning.
 * Rebuilding the environment from a fixed list of names dropped all of them,
 * and a workload that depends on one ran with a different configuration than
 * the image's author intended, without any error.
 */
const PASSED_ON_ALTHOUGH_OWNED = new Set([
  // The session a command is running for. A command needs to be able to say
  // which session it belongs to -- Hyperloom stamps it into its run manifest
  // and its LLM attribution. An identifier, not a credential; the credential is
  // AUTH_CLAW_TOKEN, which is withheld.
  "CLAW_SESSION_ID",
]);

/**
 * Whether a name is configuration of the sandbox runtime rather than of the
 * workspace, and so is withheld from a spawned command.
 *
 * The set is the one the env file is forbidden to apply (env-file.ts), so a
 * name cannot be withheld here and still be put back by a request, and a name
 * this service starts reading is withheld by the same edit that protects it.
 *
 * A deny list, which is what the allow-list this replaced was written to avoid,
 * and the trade is deliberate. The secret that matters is this service's
 * bearer token, which is in the set by name. Every other value in the
 * container's environment was put there for the workload: by the image, by the
 * pod spec, or by reference from a workspace Secret, and withholding those is
 * what broke the workloads. A child running under Hands' own identity reads
 * `/proc/1/environ` regardless, so the list was never what kept the token
 * from a child that wanted it; that is the identity boundary's job.
 */
function withheld(key: string): boolean {
  return serviceOwned(key) && !PASSED_ON_ALTHOUGH_OWNED.has(key);
}

/**
 * Names whose value is a path, or a list of them, the child will resolve
 * programs and files through.
 */
const PATH_SHAPED = new Set(["PATH", "HOME", "SHELL", "PWD"]);

/**
 * Whether every entry is an absolute path with no traversal in it.
 *
 * A relative entry resolves against whatever directory the child happens to be
 * in, and a traversal resolves outside the tree the deployment chose -- both of
 * which decide which program a bare command name runs.
 */
function usablePathValue(value: string): boolean {
  const entries = value.split(":").filter((e) => e.length > 0);
  return entries.length > 0
    && entries.every((e) => e.startsWith("/") && !e.split("/").includes(".."));
}

/**
 * The environment a spawned command runs with.
 *
 * Values pass as they are, empty ones included, as `kubectl exec` passes them:
 * a workload may set a name to the empty string on purpose. The exception is
 * a blank path-shaped name, which is left out so the shell falls back to its
 * own default rather than resolving programs against nothing.
 *
 * The request's environment from the env file needs no step of its own: the
 * file was applied to this process before anything here runs, over whatever
 * the image set, and it applies no name this service owns.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || withheld(key)) continue;
    if (PATH_SHAPED.has(key)) {
      if (value === "") continue;
      if (!usablePathValue(value)) {
        throw new ChildPrivilegeUnavailable(
          `${key} is not a usable absolute path, so no child environment could be built from it`,
        );
      }
    }
    env[key] = value;
  }
  return env;
}

/**
 * The range this sandbox declared, or null where it declared none.
 *
 * Declaring a range is declaring the boundary. Half of it is not a weaker
 * boundary, it is none: one shared identity leaves the runs sharing a sandbox
 * able to enumerate and signal one another's processes. Both questions are
 * asked from here rather than at each caller so that startup and the spawn
 * cannot answer differently -- a boot admitting a posture every later spawn
 * refuses is the sandbox reporting itself healthy while nothing it offers
 * works.
 *
 * @throws ChildPrivilegeUnavailable where a declared range cannot be used.
 */
function declaredBoundary(sandbox: SandboxIsolation): { min: number; max: number } | null {
  const range = sandbox.identityRange();
  if (!range) return null;
  if (!sandbox.partitionsProcessView()) {
    throw new ChildPrivilegeUnavailable(
      "this sandbox declares a child identity range and cannot keep one run's "
      + "processes out of another's view, so nothing can be run under the "
      + "boundary it asked for",
    );
  }
  return range;
}

/** What a deployment writes to say it is serving without the boundary. */
export const ISOLATION_UNENFORCED = "unenforced";

/**
 * Refuse to serve background shells where nothing says whether the child
 * boundary is placed.
 *
 * A child running as Hands itself reads `/proc/<parent>/environ`, so the sandbox
 * credential its own environment withholds is one open file away; and it reads
 * and writes the shell-record subtree, whose 0600/0700 modes separate it from
 * nothing under that identity. Record integrity and the scoped credential are
 * what a background shell's addressing and deduplication rest on, so silence
 * here is refused: a deployment turning the feature on states either the
 * identity range or, in `HANDS_CHILD_ISOLATION`, that it is serving without one.
 *
 * The acknowledgement is not the boundary and is not treated as one -- every
 * spawn still reports itself unenforced -- but it is a decision somebody made
 * rather than a default nobody saw.
 *
 * At startup and for the feature as a whole, not per start: every start would
 * meet the same answer, and a process refusing each one in turn is a sandbox
 * reporting itself healthy while nothing it offers works.
 *
 * That is why a declared range is checked ahead of the feature gate rather than
 * behind it. Whether one can be honoured is not a question about background
 * shells -- the foreground path resolves the same boundary through the same
 * two questions -- so a deployment declaring a range answers for it here
 * whether or not it serves any. The gate below is for the deployment that
 * declared nothing, which is the one case where serving no background shells
 * means there is nothing left to ask.
 *
 * @throws ChildPrivilegeUnavailable where the feature is on and neither is
 * stated, or where a declared range cannot be used.
 */
export function assertChildBoundaryForBackgroundShells(bgShellEnabled: boolean): void {
  if (declaredBoundary(sandboxIsolation()) !== null) return;
  if (!bgShellEnabled) return;
  if (process.env.HANDS_CHILD_ISOLATION === ISOLATION_UNENFORCED) {
    reportUnenforced();
    return;
  }
  throw new ChildPrivilegeUnavailable(
    "BG_SHELL_ENABLED is set and this sandbox states no child isolation: every "
    + "background shell would run as Hands itself and could read the sandbox "
    + "credential and the shell records that address it. Declare "
    + "HANDS_CHILD_UID_MIN/MAX, or set "
    + `HANDS_CHILD_ISOLATION=${ISOLATION_UNENFORCED} to serve without the boundary`,
  );
}

/**
 * The identity, process view and environment for one pair's next spawn.
 *
 * @throws ChildPrivilegeUnavailable where the sandbox declares an identity
 * range and cannot partition the process view, or has no identity left.
 */
export function resolveChildPrivilege(owner: string, run: string): ChildPrivilege {
  const sandbox = sandboxIsolation();
  // A declared range this sandbox cannot honour throws from here rather than
  // reading as no declaration: the two are opposite answers, and collapsing
  // them serves the command under Hands' identity on a deployment that asked
  // for the boundary.
  const range = declaredBoundary(sandbox);
  if (!range) {
    reportUnenforced();
    return { env: childEnvironment() };
  }
  const id = identityFor(owner, run, range);
  return { uid: id, gid: id, env: childEnvironment() };
}

/**
 * Say so on every spawn, not once at startup: an operator has to see which
 * commands were served without the boundary, not merely that some were.
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
