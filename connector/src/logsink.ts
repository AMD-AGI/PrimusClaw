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
 * worth the connection. So each line is written here, and a line that cannot be written is kept in memory instead (the
 * newest {@link HELD_LINES}; older ones are dropped and counted). The file is tried again after {@link RETRY_PRIMARY_MS};
 * once it takes a line, a note says what happened meanwhile and the lines held are written after it.
 *
 * Nothing else is opened or written on the way: no fallback file another account could redirect, no second disk that
 * could stall the process.
 */
import fs from "node:fs";
import tty from "node:tty";

/** After a failed write, the descriptor is left alone for this long before it is tried again. */
export const RETRY_PRIMARY_MS = 30_000;
/** Lines kept in memory while the descriptor fails; older ones are dropped and counted. */
export const HELD_LINES = 500;

export interface LineSinkOptions {
  /** The descriptor the lines are meant for (1 or 2). */
  fd: number;
  /** The stream over that descriptor (process.stdout or process.stderr): a pipe or a terminal is written through it. */
  stream?: NodeJS.WriteStream;
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
 * A function that writes one line and never throws, never ends the process. A descriptor on a file (or a character
 * device) is written synchronously, as Node writes it, so a failure is known at once; a pipe or a terminal goes through
 * its stream, and once that stream has failed (its reader gone) the lines after it are dropped and counted.
 */
export function lineSink(o: LineSinkOptions): (line: string, force?: boolean) => void {
  const now = o.now ?? Date.now;
  const writeFd = o.writeFd ?? writeAll;
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
  let since = "";
  let failure = "";
  const held: string[] = [];
  let dropped = 0;

  const hold = (data: string): void => {
    held.push(data);
    if (held.length > HELD_LINES) { held.shift(); dropped += 1; }
  };

  // `force`: try the descriptor now even within the pause (a last line before the process exits).
  return (line: string, force = false): void => {
    const data = line + "\n";
    if (!direct) {
      if (streamBroken) { dropped += 1; return; }
      try { o.stream!.write(data); } catch { streamBroken = true; dropped += 1; }
      return;
    }
    if (failedAt !== null && !force && now() - failedAt < RETRY_PRIMARY_MS) { hold(data); return; }
    try {
      if (failedAt !== null) {
        writeFd(o.fd, `${new Date(now()).toISOString()} claw-connector: this log could not be written from ${since} (${failure}); the last ${held.length} line(s) follow, ${dropped} older one(s) dropped\n`);
        // Each held line leaves the list only once written: a failure halfway keeps the rest for the next try.
        while (held.length > 0) { writeFd(o.fd, held[0]!); held.shift(); }
        failedAt = null;
        dropped = 0;
      }
      writeFd(o.fd, data);
    } catch (e) {
      if (failedAt === null) since = new Date(now()).toISOString();
      failedAt = now();
      failure = codeOf(e);
      hold(data);
    }
  };
}
