// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Writes to the state directory, kept off the event loop.
 *
 * The state directory may sit on a network file system (CephFS, NFS) that can stop answering for seconds or minutes.
 * A synchronous write there blocks the whole process, heartbeat included, for as long as the file system does: Claw
 * sees the machine go offline although nothing is wrong with it. So the writes made while running go through here:
 * asynchronous (a stuck one holds one libuv worker thread, never the event loop), one at a time per file or log, and
 * coalesced, so a stall piles up no backlog of writes, only the newest content. A caller that must know its write
 * landed waits a bounded time ({@link STATE_WRITE_WAIT_MS}) and goes on without it.
 *
 * Nothing is logged while a write is stuck (the log itself is usually a file on the same disk, and writing to it would
 * block); a slow write is reported once it finishes.
 */
import fsp from "node:fs/promises";
import path from "node:path";

/** How long a caller that waits for a state write waits before going on without it. */
export const STATE_WRITE_WAIT_MS = 10_000;
/** A write that took longer than this is reported when it finishes. */
export const SLOW_WRITE_MS = 5_000;
/** A failed snapshot write is tried again after this, doubling up to {@link RETRY_MAX_MS}, until it lands. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/** Told of a write that failed, or finished slowly (`ms` past {@link SLOW_WRITE_MS}). */
export type WriteReport = (what: string, info: { ms: number; error?: string }) => void;

/** `p`, or `late` once `ms` have passed; `p` itself goes on. */
export function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(late), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(late); });
  });
}

/** Runs `op`, reporting a failure or a slow finish; never rejects. True when it succeeded. */
export async function timed(what: string, op: () => Promise<unknown>, report?: WriteReport): Promise<boolean> {
  const t0 = Date.now();
  try {
    await op();
    const ms = Date.now() - t0;
    if (ms > SLOW_WRITE_MS) report?.(what, { ms });
    return true;
  } catch (e) {
    report?.(what, { ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Write `data` to `file` whole: a temporary file, then a rename, so a reader sees the old content or the new.
 *
 * `durable` also flushes the data to the disk before the rename (and the rename after it), so that holds after the machine
 * went down too. Without it a rename can reach the disk before the data it names (a network file system's client, ext4
 * without auto_da_alloc): after a crash the file is there but empty or garbage. connector.json read that way made a
 * machine register again as a new connector (2026-11-07, a node reboot). A flush costs tens of milliseconds on some
 * disks, so only the files that name the connector take it, not the outbox and session files written per event.
 */
export async function writeWhole(file: string, data: string, mode = 0o600, durable = false): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  if (!durable) {
    await fsp.writeFile(tmp, data, { mode });
    await fsp.rename(tmp, file);
    return;
  }
  const fh = await fsp.open(tmp, "w", mode);
  try {
    await fh.writeFile(data);
    // A file system (or a special file) that cannot flush on request says so with EINVAL/ENOTSUP: written as before then.
    await fh.sync().catch((e: NodeJS.ErrnoException) => { if (e.code !== "EINVAL" && e.code !== "ENOTSUP") throw e; });
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  // The rename itself, best effort: a directory cannot be opened for this everywhere (Windows), and the content is safe
  // either way (a rename that did not last leaves the previous, whole, file).
  try {
    const d = await fsp.open(dir, "r");
    try { await d.sync(); } finally { await d.close(); }
  } catch { /* not supported here */ }
}

/**
 * A small file that is rewritten whole (connector.json): `save` returns at once, the newest content is written in the
 * background, one write at a time. Content saved while a write is under way replaces whatever else was waiting.
 *
 * A write that fails (a quota used up, a disk full or gone) is tried again on its own, after {@link RETRY_MIN_MS} and then
 * up to every {@link RETRY_MAX_MS}, until it lands or newer content replaces it: children.json, which `stop` reads to find
 * the agents to end, must not stay stale until something else happens to change (2026-11-07, EDQUOT on an NFS share).
 */
export class SnapshotFile {
  private latest = "";
  /** Saves made, and the newest of them on disk; a write that failed is tried again by the next save. */
  private saved = 0;
  private written = 0;
  private failed = 0;
  private running: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private closed = false;
  private readonly waiters: Array<{ upTo: number; resolve: (ok: boolean) => void }> = [];

  /**
   * `durable`: each write is flushed to the disk before it replaces the file ({@link writeWhole}). `access`: how a retry
   * checks that the directory is still there (the tests hold it pending).
   */
  constructor(
    readonly file: string, private readonly report?: WriteReport, private readonly durable = false,
    private readonly access: (dir: string) => Promise<unknown> = (dir) => fsp.access(dir),
  ) {}

  /**
   * Content equal to the newest already saved is not written again while that one is on disk or a write under way will put it
   * there: connector.json is saved after every heartbeat, and rewriting (and, durable, flushing) an unchanged file each time kept
   * the libuv thread pool busy, so every other file operation of the process (an adapter's start, the session records an event
   * waits for) queued behind those flushes. After a failed write the same content is written again, as before.
   */
  save(data: string): void {
    if (this.saved > 0 && data === this.latest && this.failed < this.saved && (this.written >= this.saved || this.running !== null)) return;
    this.latest = data;
    this.saved += 1;
    this.running ??= this.drain();
  }

  /**
   * Whether everything saved so far is on disk: false when a write failed, or after `ms` (never, for `Infinity`). Asked
   * after a failed write, it tries that write again rather than wait for a drain that is not coming.
   */
  settled(ms: number = STATE_WRITE_WAIT_MS): Promise<boolean> {
    const upTo = this.saved;
    if (this.written >= upTo) return Promise.resolve(true);
    const done = new Promise<boolean>((resolve) => this.waiters.push({ upTo, resolve }));
    // The last write failed and nothing was saved since, so no drain is under way and none would ever answer this
    // waiter: write the newest content again now. It answers true when that write lands, false when it fails too.
    if (this.running === null) {
      this.failed = this.written;
      this.running = this.drain();
    }
    return Number.isFinite(ms) ? within(done, ms, false) : done;
  }

  private async drain(): Promise<void> {
    while (this.written < this.saved && this.failed < this.saved) {
      const upTo = this.saved;
      const ok = await timed(`writing ${this.file}`, () => writeWhole(this.file, this.latest, 0o600, this.durable), this.report);
      if (ok) this.written = upTo;
      else this.failed = upTo;
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i]!;
        if (w.upTo <= upTo) { this.waiters.splice(i, 1); w.resolve(ok); }
      }
    }
    this.running = null;
    // Saved again while the last write was failing: try once more for the newer content.
    if (this.written < this.saved && this.failed < this.saved) this.running = this.drain();
    else if (this.written < this.saved) this.retryLater();
    else this.retries = 0;
  }

  /** No more retries on its own (the connector that owns the file has stopped); `save` and `settled` still write. */
  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** The retry itself, unless closed meanwhile, or a drain already runs, or nothing is left to write. */
  private retryNow(): void {
    if (this.closed || this.running !== null || this.written >= this.saved) return;
    this.failed = this.written;
    this.running = this.drain();
  }

  /** After a failed write with nothing newer to write: the same content again, later. */
  private retryLater(): void {
    if (this.retryTimer !== null || this.closed) return;
    const ms = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.retries, 10));
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed || this.running !== null || this.written >= this.saved) return;
      // A directory that is gone (removed on purpose: a reinstall, a test's cleanup) is not made again by a retry of its
      // own; a save or a settled() writes it as before. The check holds nothing: a save or a settled() that arrives
      // while it is under way starts its drain at once, exactly as with no retry pending.
      this.access(path.dirname(this.file)).then(() => this.retryNow(), (e: NodeJS.ErrnoException) => {
        // Anything but ENOENT (the disk not answering): tried again later.
        if (e?.code !== "ENOENT") this.retryLater();
      });
    }, ms);
    this.retryTimer.unref?.();
  }
}

/**
 * Operations on the state directory that must happen in order (the outbox's appends, rewrites and acknowledgements, the
 * audit trail's lines): each runs after the one before it has finished or failed. `idle` resolves once everything
 * queued so far has run.
 */
export class DiskQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly report?: WriteReport) {}

  /** Operations queued and not yet finished. */
  get backlog(): number { return this.queued; }

  run(what: string, op: () => Promise<unknown>): Promise<boolean> {
    this.queued += 1;
    const done = this.tail.then(() => timed(what, op, this.report)).finally(() => { this.queued -= 1; });
    this.tail = done.then(() => undefined);
    return done;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
