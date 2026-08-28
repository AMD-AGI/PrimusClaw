// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bootstrap Hands MCP server inside a sandbox.
 * Uses the SaFE data-plane exec API (same as V1 _bootstrap_executor + sbx.exec).
 *
 * Bun-compiled binary only. Three sources, tried in ascending cost:
 *   1. /app/hands-binary                         (already in the image, free)
 *   2. CLAW_DEPLOY_ROOT/hands-binary             (shared mount, no network)
 *   3. Brain HTTP /internal/assets/hands-binary  (~90MB download per sandbox)
 *
 * Which one applies used to be decided by guessing from the image name --
 * `image.includes("primussafe/claw") || image.includes("primus-claw-hands")`.
 * Any other image was assumed not to ship Hands and went straight past the free
 * source, so a site that baked Hands into its own image still paid the 90MB
 * download for every sandbox it started. The name was never the question worth
 * asking; whether the binary is there and runs is. So each source is now
 * attempted in order until one produces a live process.
 */
import pino from "pino";
import {
  CLAW_DEPLOY_ROOT, BRAIN_HTTP_URL, LOCAL_MODE_HANDS_BINARY,
  HANDS_BOOTSTRAP_START_TIMEOUT, BG_SHELL_ENABLED, BASH_FOREGROUND_DEFAULT_SEC,
  WAIT_DEFAULT_SEC, HANDS_ENV_FILE_WAIT_SEC,
} from "../config.js";
import { toolTimeoutCeilingSec } from "../tools/hands.js";

const logger = pino({ name: "sandbox-bootstrap" });

export type SandboxExecFn = (cmd: string, timeout: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** One place the Hands binary might come from, and the command that tries it. */
export interface HandsBinarySource {
  name: "in_image" | "shared_storage" | "brain_http";
  cmd: string;
}

/** Path Claw's own Dockerfile installs the compiled binary to. */
export const HANDS_IN_IMAGE_BINARY = "/app/hands-binary";
/** Where the Brain HTTP fallback stores the downloaded binary. */
export const HANDS_DOWNLOADED_BINARY = "/tmp/.hands-binary";

/**
 * How long the in-image probe may run before it is killed.
 *
 * `--self-check` only exists in Hands built after 2026-07-31. An older binary
 * does not recognise the flag and falls through to its normal path: it binds
 * Hands' port and serves forever. The probe runs in the foreground, so it never
 * returns, and the exec timeout only abandons the stream -- the process keeps
 * running and keeps the port. Every source tried afterwards then dies with
 * EADDRINUSE, which turns "this image ships an older Hands" into "this sandbox
 * can never start Hands at all", with a live and healthy server on the port the
 * whole time.
 *
 * Killing the probe frees the port for the next source. Ten seconds is far more
 * than a real self-check needs (it prints a tool count and exits) and far less
 * than the exec budget, so a bounded probe costs nothing on an image that
 * answers properly.
 */
const SELF_CHECK_TIMEOUT_SEC = 10;

/** Build the curl command that downloads a Brain-served asset into the sandbox.
 *  Uses BRAIN_HTTP_URL (in-cluster brain ClusterIP svc) so the request
 *  load-balances across brain pods and survives rolling updates. */
function brainAssetCurl(endpoint: string, token: string): string {
  return `curl -sfL --retry 3 --retry-delay 2 `
    + `-H 'Authorization: Bearer ${token}' `
    + `${BRAIN_HTTP_URL}${endpoint}`;
}

/**
 * Shell snippet: fail the source if the Hands it started ignored the env file.
 *
 * Starting is not the same as consuming. `--self-check` only proves the binary
 * runs, and reading `HANDS_ENV_FILE` is newer than that flag, so there is a
 * range of images whose Hands passes the probe, comes up, answers /health, and
 * silently runs every command without the user's environment -- the precise
 * failure the file was added to remove, and one that is invisible on the SaFE
 * path only because the pod spec carries the same values.
 *
 * Hands reads the file and unlinks it, so its absence is the proof -- but only
 * of *this* Hands, which is why the caller rewrites the file before every
 * source. A file consumed by a source that then died would otherwise read as
 * proof for the next one, whose Hands found nothing to read.
 *
 * The process this source started is killed on the way out: it holds the MCP
 * port, and leaving it there would fail the next source with a bind error
 * instead of its own verdict. TERM first and KILL a second later, because a
 * Hands that handles TERM gracefully still holds the port while it does, and
 * to the whole process group, since `setsid` gave it one and anything it
 * forked holds the port too.
 *
 * The loop counts in shell rather than through `seq`: every image is probed
 * now, not only the ones whose name we recognise, and an image without
 * coreutils would otherwise expand to an empty list, check once, and fail a
 * healthy Hands with a message about a binary that is too old.
 */
function envFileConsumedGuard(envFile: string, waitSec: number): string {
  return `_w=0; while [ $_w -lt ${waitSec} ] && [ -f ${envFile} ]; do `
    + `sleep 1; _w=$((_w+1)); done; `
    + `if [ -f ${envFile} ]; then `
    + `echo "hands started but never read ${envFile}; this binary predates HANDS_ENV_FILE support" >&2; `
    + `kill -- -$PID 2>/dev/null || kill $PID 2>/dev/null; sleep 1; `
    // dash's kill builtin accepts `kill -- -$PID` (the `--` keeps the
    // negative pgid from being read as a signal) but rejects `kill -9 -- -$PID`
    // with "Illegal number: -". SIGKILL therefore has no `--`; both shells
    // accept `kill -9 -$PID` for a process group.
    + `kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null; `
    + `exit 1; fi; `;
}

/**
 * Start the binary, confirm it is still alive a second later, and confirm it
 * took the environment it was handed.
 *
 * Shared by every source, because the three of them used to carry three
 * hand-copied versions of this tail with three different messages for the same
 * failure, and the download source once backgrounded the whole chain and so
 * reported success for a download that never finished.
 */
function launchCmd(
  baseEnv: string,
  binPath: string,
  envFile?: string,
  envWaitSec: number = HANDS_ENV_FILE_WAIT_SEC,
  logPath: string = "/workspace/hands.log",
): string {
  // Truncate is a statement of its own, not `truncate && start &`. `&`
  // backgrounds a whole AND-OR list, so that form made `$!` the helper
  // shell bash forks to run the list -- dash happens to exec-replace it
  // with the setsid process, bash does not, and the kill chain then hits
  // the helper while Hands keeps the port.
  return `: > ${logPath} || { echo "cannot write ${logPath}" >&2; exit 1; }; `
    + `${baseEnv} setsid ${binPath} </dev/null >>${logPath} 2>&1 & `
    + `PID=$!; sleep 1; `
    + `if ! kill -0 $PID 2>/dev/null; then echo "hands-binary at ${binPath} crashed immediately" >&2; cat ${logPath} >&2; exit 1; fi; `
    + (envFile ? envFileConsumedGuard(envFile, envWaitSec) : "")
    + `echo started_pid=$PID`;
}

/**
 * Shell snippet: run the copy the image already carries.
 *
 * `binPath`, `timeoutSec`, `envWaitSec` and `logPath` are parameters so a
 * test can point the probe at a stand-in binary, not wait out the production
 * bounds, and not write the production log path on the host; production
 * callers pass none of them.
 */
export function inImageStartCmd(
  baseEnv: string,
  binPath: string = HANDS_IN_IMAGE_BINARY,
  timeoutSec: number = SELF_CHECK_TIMEOUT_SEC,
  envFile?: string,
  envWaitSec: number = HANDS_ENV_FILE_WAIT_SEC,
  logPath: string = "/workspace/hands.log",
): string {
  // `--self-check` rather than a plain -x test, because every image is probed
  // now instead of only the ones whose name we recognised: the question is
  // whether this image ships a working Hands, not whether something occupies
  // that path. Claw's own Dockerfile runs the identical check at build time, so
  // this cannot reject an image the name guess used to accept.
  //
  // `timeout` for the reason SELF_CHECK_TIMEOUT_SEC explains. An image with no
  // `timeout` on PATH fails the probe and falls through to the next source,
  // which is what a probe that answers "no" does anyway.
  return `test -x ${binPath} && timeout -k 2 ${timeoutSec} ${binPath} --self-check >/dev/null 2>&1 `
    + `|| { echo "no usable hands-binary at ${binPath}" >&2; exit 1; }; `
    + launchCmd(baseEnv, binPath, envFile, envWaitSec, logPath);
}

/** Shell snippet: run binary directly from shared storage mount. */
function sharedStorageStartCmd(baseEnv: string, envFile?: string): string {
  return `test -f ${LOCAL_MODE_HANDS_BINARY} && test -x ${LOCAL_MODE_HANDS_BINARY} || { echo "hands-binary not found or not executable" >&2; exit 1; } && `
    + launchCmd(baseEnv, LOCAL_MODE_HANDS_BINARY, envFile);
}

/** Shell snippet: download binary from Brain via curl, then run.
 *  Stored under /tmp (root-owned, world-writable but auto-cleaned on reboot)
 *  to keep it out of the user-visible /workspace mount. */
function brainDownloadStartCmd(baseEnv: string, handsToken: string, envFile?: string): string {
  const binPath = HANDS_DOWNLOADED_BINARY;
  // Download + chmod + size-check run in the FOREGROUND (synchronous) so a slow
  // or failed fetch surfaces as a non-zero exit and bootstrap throws the real
  // error. The previous form backgrounded the ENTIRE
  // `curl && chmod && :>log && setsid bin & echo started_pid=$!` chain, so the
  // step ALWAYS reported success (the foreground `echo` exits 0) even when the
  // download never completed — Brain then waited out the whole /health poll on a
  // /workspace/hands.log that was never created (the observed
  // `sandbox_health_failed` with "hands.log: No such file or directory"). Only
  // the final binary launch is backgrounded, then verified alive, mirroring
  // sharedStorageStartCmd.
  return `${brainAssetCurl("/internal/assets/hands-binary", handsToken)} -o ${binPath} || { echo "hands-binary download failed" >&2; exit 1; }; `
    + `chmod +x ${binPath} || { echo "chmod hands-binary failed" >&2; exit 1; }; `
    + `test -s ${binPath} || { echo "hands-binary is empty after download" >&2; exit 1; }; `
    + launchCmd(baseEnv, binPath, envFile);
}

/**
 * The sources to try, cheapest first.
 *
 * `in_image` is unconditional: it costs one `test -x` on images that do not
 * have it, and it is the only source that costs nothing on images that do.
 * The other two appear only when configured, so a deployment with neither is
 * left with one attempt and an error naming it, rather than the previous
 * up-front refusal that also turned away images carrying their own binary.
 *
 * Exported for tests: the commands are pure strings, so the ordering and the
 * conditions are checkable without a sandbox.
 */
export function handsBinarySources(
  baseEnv: string,
  handsToken: string,
  envFile?: string,
): HandsBinarySource[] {
  const sources: HandsBinarySource[] = [
    { name: "in_image", cmd: inImageStartCmd(baseEnv, HANDS_IN_IMAGE_BINARY, SELF_CHECK_TIMEOUT_SEC, envFile) },
  ];
  if (CLAW_DEPLOY_ROOT) {
    sources.push({ name: "shared_storage", cmd: sharedStorageStartCmd(baseEnv, envFile) });
  }
  if (BRAIN_HTTP_URL) {
    sources.push({ name: "brain_http", cmd: brainDownloadStartCmd(baseEnv, handsToken, envFile) });
  }
  return sources;
}

/**
 * The env every source prefixes onto the binary it launches.
 *
 * `BG_SHELL_ENABLED` is forwarded rather than configured separately in the
 * sandbox: Brain used the flag only to pick which tool schemas the model saw,
 * while Hands ran background shells for anyone who asked. Sending Brain's value
 * along with the binary keeps one setting instead of two that can disagree, and
 * every bootstrap path goes through here.
 *
 * `BASH_MAX_TIMEOUT_SEC` travels for the same reason. Brain puts the ceiling in
 * the tool schema it shows the model; Hands is what actually stops the process.
 * A schema promising one limit while the sandbox enforces another is worse than
 * either number by itself, because the model plans against the one it was told.
 * What travels is therefore `toolTimeoutCeilingSec`, the setting held under the
 * MCP hard cap, rather than the setting: with background shells off the two are
 * 3540 and 36000, and the schema and the RPC deadline are both built from the
 * held one. `BASH_DEFAULT_TIMEOUT_SEC` goes with it because the schema states
 * both, and they are only the same number while the ceiling is the 120s one.
 *
 * `WAIT_MAX_SEC` travels for a third version of the same reason, and through
 * the same ceiling: Brain builds the RPC deadline for a `wait` from it, and a
 * Hands clamping waits to a different number would leave the run waiting on a
 * call that has returned. `WAIT_DEFAULT_SEC` goes with it for the reason
 * `BASH_DEFAULT_TIMEOUT_SEC` does: the schema states the default too.
 */
export function handsBaseEnv(
  sessionId: string,
  mcpPort: string,
  handsToken: string,
  envFile?: string,
): string {
  return `AUTH_CLAW_TOKEN=${handsToken} CLAW_SESSION_ID=${sessionId} `
    + `MCP_PORT=${mcpPort} WORKSPACE_PATH=/workspace `
    + `BG_SHELL_ENABLED=${BG_SHELL_ENABLED ? "true" : "false"} `
    + `BASH_MAX_TIMEOUT_SEC=${toolTimeoutCeilingSec("bash")} `
    + `BASH_DEFAULT_TIMEOUT_SEC=${BASH_FOREGROUND_DEFAULT_SEC} `
    + `WAIT_MAX_SEC=${toolTimeoutCeilingSec("wait")} `
    + `WAIT_DEFAULT_SEC=${WAIT_DEFAULT_SEC}`
    + (envFile ? ` HANDS_ENV_FILE=${envFile}` : "");
}

/**
 * Where the per-request environment is handed over.
 *
 * Under /tmp rather than /workspace: the workspace is synced to S3 and to the
 * shared filesystem, and this file holds the user's own secrets.
 */
export const HANDS_ENV_FILE = "/tmp/.hands-env";

/**
 * Deliver the per-request environment to the sandbox as a file.
 *
 * Until now it travelled only in the pod spec, which is fine as long as every
 * pod is created for the request it serves -- and is exactly what a warm pool
 * breaks. A pooled pod is created before anyone knows whose request it will
 * take, so the environment carrying `user_env`, `session_env`, the system env
 * and the LLM keys is decided too late to be part of it, and a pod's
 * environment cannot be changed once it is running. That is the whole reason
 * `AGENT_SANDBOX_WARM_POOL_SIZE` has been pinned to 0: enabling it would have
 * produced sandboxes that look healthy and are missing the user's credentials.
 *
 * Bootstrap already reaches into the sandbox to start Hands, and that happens
 * after the request is known, so the environment can go the same way. Hands
 * reads the file at startup, applies it to its own process, and removes it;
 * every shell it spawns inherits the result, which is where these values were
 * always headed.
 *
 * JSON, base64-encoded for transport: values contain newlines, quotes and
 * shell metacharacters, and neither a `KEY=VALUE` file sourced by the shell
 * nor an argv-length-limited command line survives those intact.
 */
export function writeEnvFileCmd(env: Record<string, string>): string {
  const payload = Buffer.from(JSON.stringify(env), "utf8").toString("base64");
  return `printf '%s' '${payload}' | base64 -d > ${HANDS_ENV_FILE} && chmod 600 ${HANDS_ENV_FILE}`;
}

export async function bootstrapHandsInSandbox(
  execFn: SandboxExecFn,
  sessionId: string,
  mcpPort: string,
  handsToken: string,
  /**
   * The composed sandbox environment. Omitted by callers that have already
   * placed it in the pod spec and have no warm pool to worry about; passing it
   * is harmless in that case, since the values agree.
   */
  env?: Record<string, string>,
): Promise<void> {
  const mkdir = await execFn("mkdir -p /workspace && chmod 777 /workspace", "30s");
  if (mkdir.exitCode !== 0) {
    throw new Error(
      `bootstrap.mkdir_workspace exit_code=${mkdir.exitCode} stderr=${mkdir.stderr.slice(0, 300)}`,
    );
  }

  const envToPlace = env && Object.keys(env).length ? env : undefined;
  const envFile = envToPlace ? HANDS_ENV_FILE : undefined;
  const baseEnv = handsBaseEnv(sessionId, mcpPort, handsToken, envFile);
  const sources = handsBinarySources(baseEnv, handsToken, envFile);
  const failures: string[] = [];

  try {
    for (const source of sources) {
      logger.info({ sessionId, source: source.name }, "bootstrap.start_hands.attempt");
      // Rewritten per source rather than once, because the guard inside each
      // source reads the file's absence as proof that the Hands it just started
      // consumed it. A source whose Hands read the file and then died would
      // otherwise leave that proof lying around for the next one, which would
      // start with nothing to read and be told it had passed.
      if (envToPlace) {
        const wrote = await execFn(writeEnvFileCmd(envToPlace), "30s");
        if (wrote.exitCode !== 0) {
          // Fatal rather than degraded: a sandbox without the user's environment
          // fails later, further away, and looks like the user's own mistake.
          throw new Error(
            `bootstrap.write_env exit_code=${wrote.exitCode} stderr=${wrote.stderr.slice(0, 300)}`,
          );
        }
      }
      const r = await execFn(source.cmd, HANDS_BOOTSTRAP_START_TIMEOUT);
      if (r.exitCode === 0) {
        logger.info(
          { sessionId, source: source.name, stdout: r.stdout.slice(0, 200) },
          "bootstrap.start_hands.ok",
        );
        return;
      }
      failures.push(`${source.name} exit_code=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`);
      logger.warn(
        { sessionId, source: source.name, exitCode: r.exitCode, stderr: r.stderr.slice(0, 200) },
        "bootstrap.start_hands.source_failed",
      );
    }
  } finally {
    // Hands unlinks the file on a successful start. Every other exit -- a
    // write that failed after an earlier source had already placed it, an
    // exec-channel throw, no source working -- would otherwise leave the
    // caller's keys in /tmp until the pod's TTL.
    if (envFile) await execFn(`rm -f ${envFile}`, "30s").catch(() => {});
  }

  // Naming every source that was tried, because the failure that matters is
  // usually the last one and the reason the earlier ones were skipped.
  throw new Error(`bootstrap.start_hands: no source produced a running Hands. Tried: ${failures.join(" | ")}`);
}
