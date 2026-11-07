// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector's own output, stdout and stderr, which `service install --supervisor script` points at a file
 * (state/run.log).
 *
 * A write to that file can fail: a full disk or a quota used up (ENOSPC, EDQUOT), a network file system gone away. Node
 * turns a failed write to a file-backed stdout into an 'error' event that nobody handles, and the process dies: on
 * 2026-11-07 run.log sat on an NFS share at its quota, and a connector died on the first line it printed (and earlier a
 * supervisor and its connector died together, leaving the machine offline until someone came by). A log line is never
 * worth the connection. So each line is written here: to its file descriptor first; when that fails, to a fallback file
 * on this machine's temporary directory (another disk, as a rule); when that fails too, it is dropped and counted. A file
 * that failed is tried again after {@link RETRY_PRIMARY_MS}, and the first line that lands there again says what happened
 * meanwhile, so the log comes back to its place once there is room.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tty from "node:tty";

/** After a failed write, lines go to the fallback for this long before the original destination is tried again. */
export const RETRY_PRIMARY_MS = 30_000;
/** The fallback file is not written past this size: it sits on a temporary directory that may be small. */
export const FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

/** Where lines go when stdout or stderr cannot be written: one file per user, shared by the supervisor and its runs. */
export function fallbackLogFile(env: NodeJS.ProcessEnv = process.env): string {
  const who = typeof process.getuid === "function" ? String(process.getuid()) : (env.USERNAME ?? env.USER ?? "user");
  return path.join(os.tmpdir(), `claw-connector-${who}`, "fallback.log");
}

export interface LineSinkOptions {
  /** The descriptor the lines are meant for (1 or 2). */
  fd: number;
  /** The stream over that descriptor (process.stdout or process.stderr): a pipe or a terminal is written through it. */
  stream?: NodeJS.WriteStream;
  /** Where lines go while the descriptor fails; null drops them. Default {@link fallbackLogFile}. */
  fallback?: string | null;
  now?: () => number;
  /** Writes `data` to `fd` whole or throws (the tests make it fail). Default fs.writeSync in a loop. */
  writeFd?: (fd: number, data: string) => void;
}

const writeAll = (fd: number, data: string): void => {
  let buf = Buffer.from(data);
  while (buf.length > 0) {
    const n = fs.writeSync(fd, buf);
    buf = buf.subarray(n);
  }
};

const codeOf = (e: unknown): string => {
  const err = e as NodeJS.ErrnoException;
  return err?.errno === -122 ? "EDQUOT" : String(err?.code ?? err?.message ?? e);
};

/**
 * A function that writes one line and never throws, never ends the process. Descriptors on a file (or a character
 * device) are written synchronously, as Node does for them, so a failure is known at once and the line goes to the
 * fallback; a pipe or a terminal goes through the stream, and once that stream has failed (a reader gone) everything
 * after goes to the fallback.
 */
export function lineSink(o: LineSinkOptions): (line: string) => void {
  const now = o.now ?? Date.now;
  const writeFd = o.writeFd ?? writeAll;
  const fallback = o.fallback === undefined ? fallbackLogFile() : o.fallback;
  let direct = o.stream === undefined;
  if (!direct) {
    try {
      const st = fs.fstatSync(o.fd);
      direct = (st.isFile() || st.isCharacterDevice()) && !tty.isatty(o.fd);
    } catch { direct = false; }
  }
  let streamBroken = false;
  // Whatever writes to the stream (this, or anything else in the process), a failure is noted here, not thrown.
  o.stream?.on("error", () => { streamBroken = true; });

  let failedAt: number | null = null;
  let failure = "";
  let firstFailureAt = "";
  let toFallback = 0;
  let dropped = 0;
  let fbFd: number | null = null;
  let fbBytes = 0;
  let fbBroken = false;

  const writeFallback = (data: string): void => {
    if (fallback === null || fbBroken) { dropped += 1; return; }
    try {
      if (fbFd === null) {
        fs.mkdirSync(path.dirname(fallback), { recursive: true, mode: 0o700 });
        fbFd = fs.openSync(fallback, "a", 0o600);
        fbBytes = fs.fstatSync(fbFd).size;
        const note = `${new Date(now()).toISOString()} claw-connector (pid ${process.pid}): fd ${o.fd} cannot be written (${failure}); its lines go here until it can\n`;
        writeAll(fbFd, note);
        fbBytes += Buffer.byteLength(note);
      }
      if (fbBytes + Buffer.byteLength(data) > FALLBACK_MAX_BYTES) { dropped += 1; return; }
      writeAll(fbFd, data);
      fbBytes += Buffer.byteLength(data);
      toFallback += 1;
    } catch {
      fbBroken = true;
      dropped += 1;
    }
  };

  const fail = (e: unknown, data: string): void => {
    if (failedAt === null) firstFailureAt = new Date(now()).toISOString();
    failedAt = now();
    failure = codeOf(e);
    writeFallback(data);
  };

  return (line: string): void => {
    const data = line + "\n";
    if (!direct) {
      if (streamBroken) { failure = "the stream failed"; writeFallback(data); return; }
      try { o.stream!.write(data); } catch (e) { streamBroken = true; failure = codeOf(e); writeFallback(data); }
      return;
    }
    if (failedAt !== null && now() - failedAt < RETRY_PRIMARY_MS) { writeFallback(data); return; }
    try {
      if (failedAt !== null) {
        writeFd(o.fd, `${new Date(now()).toISOString()} claw-connector: this log could not be written from ${firstFailureAt} (${failure}): ${toFallback} line(s) went to ${fallback ?? "nowhere"}, ${dropped} dropped\n`);
        failedAt = null;
        toFallback = 0;
        dropped = 0;
      }
      writeFd(o.fd, data);
    } catch (e) {
      fail(e, data);
    }
  };
}
