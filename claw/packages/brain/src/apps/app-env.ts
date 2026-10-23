// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the AppRunner says to the sandbox: the application's environment
 * (hosting design 5.3.3) and the few shell fragments it runs through EnvD.
 *
 * Kept apart from the state machine because none of it decides anything. The
 * environment is a pure function of the manifest, the run and what the API
 * handed over, so "env assembled exactly per env_map" is checked by calling it.
 *
 * Secrets travel in the execute request's `env` map, never in the command
 * string: the Router and EnvD log every command string and neither logs the map.
 */
import { type AppManifestV1, type AppSandboxRole } from "@claw/protocol";
import { APP_SANDBOX_ROLES, scrubText } from "@claw/protocol";

/** Single-quote `s` for `sh`. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const INPUT_FILE = "input.json";
export const PID_FILE = "app.pid";
/** Which sandbox and restart generation `app.pid` belongs to. See {@link generationTag}. */
export const MARKER_FILE = "app.sandbox";
export const LOG_FILE = "app.log";
export const EXIT_FILE = "exit.json";

/**
 * Names the sandbox and restart a pid file was written for. The pid file lives
 * on shared storage and outlives containers: a number left by a gone container
 * can be a live, unrelated process in the next one, and `kill -0` cannot tell.
 */
export const generationTag = (workloadId: string, restarts: number): string => `${workloadId}:${restarts}`;

/**
 * A command that prints the state directory: the manifest's template with
 * `${run_id}` filled in here and `${USER_DATA_PATH}` left to the sandbox, which
 * is the only place that knows it. Refuses (exit 4) when the variable is needed
 * and empty, because the result would otherwise be a path at the filesystem root.
 */
export function expandStateDirCommand(template: string, runId: string): string {
  const withRun = template.split("${run_id}").join(runId);
  const parts = withRun.split("${USER_DATA_PATH}");
  const word = parts.map(shq).join('"$USER_DATA_PATH"');
  const guard = parts.length > 1 ? '[ -n "$USER_DATA_PATH" ] || exit 4; ' : "";
  return `${guard}printf %s ${word}`;
}

/** A state directory is an absolute path on one line, or the expansion went wrong. */
export function isUsableStateDir(dir: string): boolean {
  return dir.startsWith("/") && dir.length > 1 && !/[\0\n\r]/.test(dir) && !dir.split("/").includes("..");
}

/** Write base64 `$CLAW_FILE_B64` to `path` atomically. The content rides in the env map. */
export function writeFileCommand(path: string, mode: string): string {
  const p = shq(path);
  return `mkdir -p "$(dirname ${p})" && printf %s "$CLAW_FILE_B64" | base64 -d > ${p}.tmp && chmod ${mode} ${p}.tmp && mv ${p}.tmp ${p}`;
}

export type ProbeVerdict = "alive" | "dead" | "none";

/**
 * Is the process of this generation running? `none` is "nothing was started for
 * this generation", which is not the same as dead: a dead process has a result
 * to read, a missing one has to be started.
 */
export function probeCommand(stateDir: string, tag: string): string {
  const d = shq(stateDir);
  return `if [ "$(cat ${d}/${MARKER_FILE} 2>/dev/null)" != ${shq(tag)} ]; then echo none; `
    + `elif kill -0 "$(cat ${d}/${PID_FILE} 2>/dev/null)" 2>/dev/null; then echo alive; else echo dead; fi`;
}

export function parseProbe(stdout: string): ProbeVerdict | null {
  const word = stdout.trim();
  return word === "alive" || word === "dead" || word === "none" ? word : null;
}

/** Exit status of {@link readExitCommand} when there is no `exit.json`. */
export const EXIT_ABSENT = 3;

export function readExitCommand(stateDir: string): string {
  const f = shq(`${stateDir}/${EXIT_FILE}`);
  return `if [ -f ${f} ]; then cat ${f}; else exit ${EXIT_ABSENT}; fi`;
}

/** Seconds are not needed: a holder that is alive is told by its pid, not by the clock. */
const START_LOCK = ".start.lock";

/**
 * Start the application detached, unless it is already running here.
 *
 * Two things can reach this command at once: two Brains (a takeover while the
 * old Brain's last tick is still in flight), and a tick that wrongly concluded
 * the process was dead. So it serialises and it checks, both inside the sandbox,
 * which is the only place that can:
 *
 *  - A symlink is the lock (creating one is atomic and writes its holder). A contender prints `busy` and leaves the
 *    decision to the next tick's probe. A lock whose holder is no longer alive is
 *    taken over. Known limit: two contenders taking over the same dead lock at
 *    the same instant can both proceed; closing that needs `flock`, which the
 *    sandbox images are not guaranteed to have.
 *  - Under the lock, a live process of this sandbox, whatever its restart
 *    generation, means `already`: the marker is moved to this generation, so the
 *    probe agrees with reality, and nothing is launched.
 *
 * The marker is written before the launch so a launch that is never recorded
 * still names its generation.
 */
export function startCommand(manifest: AppManifestV1, stateDir: string, tag: string): string {
  const d = shq(stateDir);
  const workload = tag.slice(0, tag.lastIndexOf(":"));
  const argv = manifest.command.map(shq).join(" ");
  const events = manifest.events ? `mkdir -p ${shq(`${stateDir}/${manifest.events.dir}`)} && ` : "";
  return [
    `mkdir -p ${d} && ${events}cd ${d} || exit 1`,
    // The lock is a symlink whose target is "<pid>|<sandbox>": creating it is one
    // atomic step that also writes the holder, so a contender never sees a lock with
    // no owner written yet. It lives on shared storage and outlives containers, and a
    // pid left by a gone container can be a live, unrelated process in the next one,
    // so a holder only counts when it is of THIS sandbox as well as alive: a lock
    // of another sandbox is stale. (A directory left by an older version reads as
    // an owner-less, stale lock.)
    `if ! ln -s "$$|"${shq(workload)} ${START_LOCK} 2>/dev/null; then`,
    `  held=$(readlink ${START_LOCK} 2>/dev/null); holder=\${held%%|*}; lockwl=\${held#*|}`,
    `  if [ -n "$held" ] && [ "$lockwl" = ${shq(workload)} ] && kill -0 "$holder" 2>/dev/null; then echo busy; exit 0; fi`,
    `  rm -rf ${START_LOCK}; ln -s "$$|"${shq(workload)} ${START_LOCK} 2>/dev/null || { echo busy; exit 0; }`,
    `fi`,
    `trap 'rm -rf ${START_LOCK}' EXIT`,
    `marker=$(cat ${MARKER_FILE} 2>/dev/null)`,
    `if [ "\${marker%:*}" = ${shq(workload)} ] && kill -0 "$(cat ${PID_FILE} 2>/dev/null)" 2>/dev/null; then`,
    `  printf %s ${shq(tag)} >${MARKER_FILE}; echo already; exit 0`,
    `fi`,
    // The previous generation's exit record is not this one's: a generation that
    // dies without writing one must read as having none, not as the last one's.
    `rm -f ${shq(EXIT_FILE)}`,
    `printf %s ${shq(tag)} >${MARKER_FILE}`,
    `setsid ${argv} >>${LOG_FILE} 2>&1 </dev/null & echo $! >${PID_FILE}`,
    "echo started",
  ].join("\n");
}

export interface AppEnvSources {
  runId: string;
  sessionId: string;
  createdAt: string;
  manifest: AppManifestV1;
  stateDir: string;
  mcpToken: string;
  grantKeys: Partial<Record<AppSandboxRole, string>>;
  grantLimits: Record<string, unknown> | null;
  nodeName: string | null;
}

/**
 * The application's environment. Later sources win, in this order: the
 * manifest's `env`, the facilities `env_map` names, and last
 * the two names the platform owns (`CLAW_SESSION_ID`, `NODE_NAME`), which a
 * manifest cannot set at all (validateAppManifest reserves them).
 *
 * Only facilities the manifest maps are injected, and the MCP ones only when
 * `mcp` is declared. `mcp_public_url`, `sandbox_templates` and `result_archive`
 * are not provided by this change and stay unset.
 */
export function buildAppEnv(s: AppEnvSources): Record<string, string> {
  const { manifest } = s;
  const map = manifest.env_map ?? {};
  // The run input is not a source: Claw hands it to the app as a file
  // (`env_map.input_file`) and never reads a value out of it.
  const env: Record<string, string> = { ...(manifest.env ?? {}) };
  const set = (name: string | undefined, value: string | undefined): void => {
    if (name && value !== undefined) env[name] = value;
  };
  set(map.run_id, s.runId);
  set(map.run_created_at, s.createdAt);
  set(map.state_dir, s.stateDir);
  set(map.input_file, `${s.stateDir}/${INPUT_FILE}`);
  set(map.events_dir, manifest.events ? `${s.stateDir}/${manifest.events.dir}` : undefined);
  if (manifest.mcp) {
    set(map.mcp_port, String(manifest.mcp.port));
    set(map.mcp_token, s.mcpToken);
  }
  for (const role of APP_SANDBOX_ROLES) set(map.sandbox_keys?.[role], s.grantKeys[role]);
  set(map.grant_limits, s.grantLimits ? JSON.stringify(s.grantLimits) : undefined);
  env.CLAW_SESSION_ID = s.sessionId;
  if (s.nodeName) env.NODE_NAME = s.nodeName;
  return env;
}

/** Every secret value an environment built from these sources carries. */
export function secretValuesOf(s: Pick<AppEnvSources, "mcpToken" | "grantKeys">): string[] {
  return [s.mcpToken, ...Object.values(s.grantKeys)].filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** `text` with every secret value replaced (the shared rule; see protocol `scrubText`). */
export function scrub(text: string, secrets: readonly string[]): string {
  return scrubText(text, secrets);
}
