// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WORKSPACE } from "../../config.js";

export type ManagedShellKind = "foreground" | "background" | "monitor";
export type ManagedShellStatus = "running" | "exited" | "killed" | "timed_out" | "error";

export interface ManagedShell {
  id: string;
  kind: ManagedShellKind;
  command: string;
  pid: number;
  process: ChildProcess;
  status: ManagedShellStatus;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdoutBuf: Buffer[];
  stderrBuf: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutReadOffset: number;
  stderrReadOffset: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  truncated: boolean;
  startedAt: number;
  lastOutputAt: number;
  endedAt: number | null;
}

export interface ManagedShellResult {
  shell: ManagedShell;
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface SpawnManagedShellOptions {
  id?: string;
  kind: ManagedShellKind;
  bufferBytes: number;
  unref?: boolean;
}

interface RunForegroundOptions {
  timeoutMs: number;
  bufferBytes: number;
  terminateGraceMs?: number;
  forceResolveMs?: number;
}

/** Write a compact structured lifecycle log to stdout. */
export function logShellEvent(event: string, shell: ManagedShell, extra: Record<string, unknown> = {}): void {
  const durationMs = (shell.endedAt ?? Date.now()) - shell.startedAt;
  console.log(JSON.stringify({
    level: 30,
    time: Date.now(),
    name: "hands-shell",
    msg: event,
    shellId: shell.id,
    kind: shell.kind,
    pid: shell.pid,
    status: shell.status,
    durationMs,
    exitCode: shell.exitCode,
    signal: shell.signal,
    timedOut: shell.timedOut,
    stdoutBytes: shell.stdoutBytes,
    stderrBytes: shell.stderrBytes,
    stdoutDroppedBytes: shell.stdoutDroppedBytes,
    stderrDroppedBytes: shell.stderrDroppedBytes,
    ...extra,
  }));
}

/** Spawn a managed shell as a detached process group. */
export function spawnManagedShell(command: string, options: SpawnManagedShellOptions): ManagedShell {
  const id = options.id || `${options.kind}-${randomUUID().slice(0, 8)}`;
  const proc = spawn("/bin/sh", ["-c", command], {
    cwd: WORKSPACE,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const shell: ManagedShell = {
    id,
    kind: options.kind,
    command,
    pid: proc.pid!,
    process: proc,
    status: "running",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdoutBuf: [],
    stderrBuf: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutReadOffset: 0,
    stderrReadOffset: 0,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    truncated: false,
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    endedAt: null,
  };

  proc.stdout?.on("data", (chunk: Buffer) => appendBuffer(shell, "stdout", chunk, options.bufferBytes));
  proc.stderr?.on("data", (chunk: Buffer) => appendBuffer(shell, "stderr", chunk, options.bufferBytes));

  proc.on("exit", (code, signal) => {
    if (shell.status === "running") {
      shell.status = shell.timedOut ? "timed_out" : (signal ? "killed" : "exited");
    }
    shell.exitCode = code;
    shell.signal = signal;
    shell.endedAt = Date.now();
    // Foreground exit/error logs are emitted by runForegroundShell.finish so
    // each shell shows exactly one terminal event in the log stream.
    if (shell.kind !== "foreground") {
      logShellEvent("shell.background.exit", shell);
    }
  });

  proc.on("error", (err) => {
    shell.status = "error";
    shell.exitCode = 1;
    shell.endedAt = Date.now();
    if (shell.kind !== "foreground") {
      logShellEvent("shell.background.error", shell, { error: err.message });
    }
  });

  if (options.unref) proc.unref();
  logShellEvent(shell.kind === "foreground" ? "shell.foreground.start" : "shell.background.start", shell, {
    command: command.slice(0, 500),
  });
  return shell;
}

/** Run a foreground shell and always resolve, even when process cleanup stalls. */
export async function runForegroundShell(
  command: string,
  options: RunForegroundOptions,
): Promise<ManagedShellResult> {
  const shell = spawnManagedShell(command, {
    kind: "foreground",
    bufferBytes: options.bufferBytes,
  });
  const terminateGraceMs = options.terminateGraceMs ?? 5_000;
  const forceResolveMs = options.forceResolveMs ?? 10_000;

  return await new Promise<ManagedShellResult>((resolve) => {
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };

    const finish = (exitCode: number, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      cleanupTimers();
      if (shell.status === "running") {
        shell.status = shell.timedOut ? "timed_out" : (signal ? "killed" : "exited");
      }
      shell.exitCode = exitCode;
      shell.signal = signal;
      shell.endedAt = shell.endedAt ?? Date.now();
      const stdout = collectOutput(shell, "stdout");
      const stderr = collectOutput(shell, "stderr");
      logShellEvent(shell.timedOut ? "shell.foreground.timeout" : "shell.foreground.done", shell);
      resolve({
        shell,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut: shell.timedOut,
        stdoutTruncated: shell.stdoutDroppedBytes > 0,
        stderrTruncated: shell.stderrDroppedBytes > 0,
      });
    };

    shell.process.on("close", (code, signal) => finish(code ?? (shell.timedOut ? 124 : 1), signal));
    shell.process.on("error", () => finish(1, null));

    if (options.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        shell.timedOut = true;
        shell.status = "timed_out";
        terminateManagedProcess(shell, "SIGTERM");
        sigkillTimer = setTimeout(() => terminateManagedProcess(shell, "SIGKILL"), terminateGraceMs);
        forceTimer = setTimeout(() => {
          shell.process.stdout?.destroy();
          shell.process.stderr?.destroy();
          finish(124, "SIGKILL");
        }, forceResolveMs);
      }, options.timeoutMs);
    }
  });
}

/** Terminate the full process group, falling back to the direct child PID. */
export function terminateManagedProcess(shell: ManagedShell, signal: NodeJS.Signals): void {
  try {
    process.kill(-shell.pid, signal);
  } catch {
    try { process.kill(shell.pid, signal); } catch { /* process may already be gone */ }
  }
}

export function pollManagedOutput(shell: ManagedShell, filter?: string): { stdout: string; stderr: string; lostBytes: number } {
  const stdout = readNew(shell, "stdout");
  const stderr = readNew(shell, "stderr");
  let text = stdout.text;
  if (filter) {
    try {
      const re = new RegExp(filter, undefined);
      const lines = text.split("\n");
      const maxLines = 10_000;
      const subset = lines.length > maxLines ? lines.slice(-maxLines) : lines;
      text = subset.filter((line) => re.test(line)).join("\n");
    } catch { /* invalid regex — return all stdout */ }
  }
  return { stdout: text, stderr: stderr.text, lostBytes: stdout.lostBytes + stderr.lostBytes };
}

function appendBuffer(shell: ManagedShell, stream: "stdout" | "stderr", chunk: Buffer, maxBytes: number): void {
  const buf = stream === "stdout" ? shell.stdoutBuf : shell.stderrBuf;
  const bytesKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
  const droppedKey = stream === "stdout" ? "stdoutDroppedBytes" : "stderrDroppedBytes";

  shell[bytesKey] += chunk.length;
  shell.lastOutputAt = Date.now();

  let data = chunk;
  if (data.length > maxBytes) {
    shell[droppedKey] += data.length - maxBytes;
    data = data.subarray(data.length - maxBytes);
    shell.truncated = true;
  }
  buf.push(data);

  let totalSize = buf.reduce((sum, part) => sum + part.length, 0);
  while (totalSize > maxBytes && buf.length > 0) {
    const first = buf[0];
    const over = totalSize - maxBytes;
    if (first.length <= over) {
      buf.shift();
      totalSize -= first.length;
      shell[droppedKey] += first.length;
    } else {
      buf[0] = first.subarray(over);
      totalSize -= over;
      shell[droppedKey] += over;
    }
    shell.truncated = true;
  }
}

function collectOutput(shell: ManagedShell, stream: "stdout" | "stderr"): string {
  const buf = stream === "stdout" ? shell.stdoutBuf : shell.stderrBuf;
  const dropped = stream === "stdout" ? shell.stdoutDroppedBytes : shell.stderrDroppedBytes;
  const suffix = dropped > 0 ? `\n[${stream} truncated; ${dropped} bytes dropped]` : "";
  return Buffer.concat(buf).toString("utf-8") + suffix;
}

function readNew(shell: ManagedShell, stream: "stdout" | "stderr"): { text: string; lostBytes: number } {
  const buf = stream === "stdout" ? shell.stdoutBuf : shell.stderrBuf;
  const totalBytes = stream === "stdout" ? shell.stdoutBytes : shell.stderrBytes;
  const readOffsetKey = stream === "stdout" ? "stdoutReadOffset" : "stderrReadOffset";
  const available = Buffer.concat(buf);
  const availableStart = totalBytes - available.length;
  const previousOffset = shell[readOffsetKey];
  const start = Math.max(previousOffset, availableStart);
  const lostBytes = Math.max(0, availableStart - previousOffset);
  shell[readOffsetKey] = totalBytes;
  return { text: available.subarray(start - availableStart).toString("utf-8"), lostBytes };
}
