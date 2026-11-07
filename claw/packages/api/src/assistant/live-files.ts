// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a running worker's files say now: the tails of the files in its workspace written last (a job's progress log, its output), read
 * from the sandbox that is running when the router asks how far an item got (`work_recall(item, "live")`).
 *
 * The worker itself looks at a long job only now and then (a `sleep 95; tail` loop), so its last tool output can be minutes and steps
 * behind the job: the 2026-11-06 parity run answered "step 3/16 (23:01:27)" while the log already said step 5 (23:02:27). This reads the
 * log itself, as it is at the question.
 *
 * Read the way the session's changes are (`changes-service.ts`): from the sandbox the registry already names, never one made or woken
 * for the purpose, with one short command that takes no input. Hidden files and dependency trees are not read; what is read is cut to
 * its tail and masked as a command's output is (`redactCommandSecrets`). It is data written by the worker's job, never instructions.
 */
import pino from "pino";
import { kv } from "../infra/nats.js";
import { readHandsTarget } from "../sessions/changes-service.js";
import { execInSandbox, SandboxUnreachableError, type HandsTarget } from "../sessions/hands-exec.js";
import { WORKSPACE_ROOT } from "../sessions/changes.js";
import { redactCommandSecrets } from "../notifications/approval-target.js";

const logger = pino({ name: "assistant-live-files" });

/** Files read: the ones written last. */
export const LIVE_FILES_MAX = 3;
/** Only files written within this many minutes: a job that is running writes as it goes. */
const LIVE_FILES_MINUTES = 60;
/** Bytes read from the end of each file, and the characters of it kept. */
const LIVE_FILE_READ_BYTES = 4096;
export const LIVE_FILE_TAIL_CHARS = 1200;
/** The router is waiting: well inside Hands' own limit. */
const LIVE_FILES_TIMEOUT_SEC = 8;

/**
 * The script: no input but the root, a constant here. Paths and contents go out as base64, so nothing in them can break the framing.
 *
 * A file is opened once (fd 3) and read only through that descriptor, after checking what was opened: a regular file whose real path
 * is under the root and in no hidden or dependency directory. A path `find` listed and something in the sandbox swapped for a link
 * since (to a file outside the workspace, or to `.env`) is therefore not read.
 */
export function liveFilesScript(root: string = WORKSPACE_ROOT): string {
  const q = `'${root.replace(/'/g, `'\\''`)}'`;
  return [
    `cd ${q} 2>/dev/null || exit 0; R=$(pwd -P);`,
    `find . -xdev \\( -path '*/.*' -o -name node_modules \\) -prune -o -type f -mmin -${LIVE_FILES_MINUTES} -printf '%T@ %s %P\\0' 2>/dev/null`,
    `| sort -z -rn | head -z -n 20 | { n=0; while IFS= read -r -d '' r; do`,
    `t=\${r%% *}; rest=\${r#* }; p=\${rest#* };`,
    `exec 3<"$p" 2>/dev/null || continue;`,
    `f=$(readlink /proc/self/fd/3 2>/dev/null); rel=\${f#"$R"/};`,
    `case "$f" in "$R"/*) ;; *) exec 3<&-; continue ;; esac;`,
    `case "/$rel" in */.*|*/node_modules/*) exec 3<&-; continue ;; esac;`,
    `if [ ! -f /proc/self/fd/3 ]; then exec 3<&-; continue; fi;`,
    `s=$(stat -L -c %s /proc/self/fd/3 2>/dev/null || echo 0);`,
    // Text only: a binary file's tail says nothing to a person.
    // Each read opens /proc/self/fd/3, the file fd 3 holds (not its path again), from its start.
    `if [ "$s" = 0 ] || head -c 8192 /proc/self/fd/3 2>/dev/null | LC_ALL=C grep -Iq . ; then`,
    `printf '@@FILE %s %s %s\\n' "\${t%.*}" "$s" "$(printf %s "$rel" | base64 -w0)";`,
    `printf '@@TAIL %s\\n' "$(tail -c ${LIVE_FILE_READ_BYTES} /proc/self/fd/3 2>/dev/null | base64 -w0)";`,
    `n=$((n+1)); fi; exec 3<&-; [ "$n" -ge ${LIVE_FILES_MAX} ] && break; done; };`,
    `printf '@@NOW %s\\n' "$(date +%s)"`,
  ].join(" ");
}

export interface LiveFile {
  path: string;
  /** When the file was last written, by the sandbox's clock. */
  modified_at: string;
  size: number;
  /** Its last lines, masked and cut. */
  tail: string;
}

export type LiveFiles =
  | { status: "read"; read_at: string; files: LiveFile[] }
  | { status: "not_running" | "unavailable" };

const b64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

/** The script's output, as the router is given it. */
export function parseLiveFiles(output: string): LiveFiles {
  const files: LiveFile[] = [];
  let now: number | null = null;
  let pending: { path: string; modified_at: string; size: number } | null = null;
  for (const line of output.split("\n")) {
    const file = /^@@FILE (\d+) (\d+) ([A-Za-z0-9+/=]*)$/.exec(line);
    if (file) {
      pending = { path: redactCommandSecrets(b64(file[3])).slice(0, 300), modified_at: new Date(Number(file[1]) * 1000).toISOString(), size: Number(file[2]) };
      continue;
    }
    const tail = /^@@TAIL ([A-Za-z0-9+/=]*)$/.exec(line);
    if (tail && pending) {
      // A cut at the start of the bytes read can split a character or a line: the first, partial line is dropped when there are more.
      let text = b64(tail[1]).replace(/\r/g, "");
      if (pending.size > LIVE_FILE_READ_BYTES && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
      text = redactCommandSecrets(text).replace(/\s+$/, "");
      files.push({ ...pending, tail: text.length > LIVE_FILE_TAIL_CHARS ? `…${text.slice(-LIVE_FILE_TAIL_CHARS)}` : text });
      pending = null;
      continue;
    }
    const at = /^@@NOW (\d+)$/.exec(line);
    if (at) now = Number(at[1]);
  }
  return { status: "read", read_at: new Date(now !== null ? now * 1000 : Date.now()).toISOString(), files };
}

/** The registry read and the command, behind a seam: tests substitute them. */
export const liveFilesPorts = {
  readTarget: (sessionId: string): Promise<HandsTarget | null> => readHandsTarget(sessionId, kv),
  exec: execInSandbox,
};

/** The newest files of the worker's running sandbox, now. `not_running` when the registry names no sandbox that is ready. */
export async function readLiveFiles(workerSessionId: string): Promise<LiveFiles> {
  const target = await liveFilesPorts.readTarget(workerSessionId);
  if (!target) return { status: "not_running" };
  try {
    const result = await liveFilesPorts.exec(target, liveFilesScript(), LIVE_FILES_TIMEOUT_SEC);
    if (result.isError) return { status: "unavailable" };
    return parseLiveFiles(result.text);
  } catch (err) {
    if (err instanceof SandboxUnreachableError) return { status: "not_running" };
    logger.warn({ workerSessionId, err: (err as Error)?.message }, "assistant.live_files_failed");
    return { status: "unavailable" };
  }
}
