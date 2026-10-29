// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { SKILL_CACHE_MAX_BYTES } from "../config.js";

/**
 * Brain-process cache of the files of a downloaded skill.
 *
 * Before it, every turn fetched every skill again: a plugin with a dozen skills
 * paid a listing and one object read per file, a dozen times, to arrive at the
 * bytes it had written to disk the turn before. The files are now kept in
 * memory, keyed by the skill and validated by a fingerprint the CALLER derives
 * from what the source says the skill is right now:
 *
 *   - plugin skills (object store): the listing's per-object ETag and size, so
 *     an in-place upsert that rewrites the same key under the same version
 *     string is seen, which the version in `s3_key` alone would never show;
 *   - marketplace `tool_ids` skills: the tool record's version and `updated_at`,
 *     which every in-place update (`toolUpdate`) bumps.
 *
 * An entry is served only when its fingerprint equals the one the caller just
 * read. There is no TTL: a stale entry cannot be returned, it can only be
 * replaced. Where the caller cannot derive a fingerprint (a store that returns
 * no ETag, a record without `updated_at`, a failed read of either) the skill is
 * downloaded and not cached, so "could not tell" never counts as "unchanged".
 *
 * The cache holds bytes, not directories. Every caller still gets its own copy
 * written into its own private staging directory (the directory it was already
 * going to download into), so nothing a session reads can be evicted, replaced
 * or modified by another session, and the staging-directory protections of
 * `createPrivateStagingRoot` apply to cached and fresh files alike.
 *
 * The download itself is the caller's existing code, passed in as `download`;
 * this class decides only whether to run it.
 */

interface SkillFile { rel: string; bytes: Buffer }
interface Entry { fingerprint: string; files: SkillFile[]; size: number }

/**
 * What a held skill costs against the bound beyond its content bytes: per file a
 * path string, a Buffer and an array slot, per entry the key, the fingerprint
 * and the map's bookkeeping. Charging content alone would let any number of
 * empty or tiny skills sit under the bound, and the maps behind it grow without
 * limit. Deliberately generous: the point is that every entry has a real price,
 * so that `maxBytes` bounds how many there can be as well as how large.
 */
export const ENTRY_OVERHEAD_BYTES = 1024;
export const FILE_OVERHEAD_BYTES = 256;

/** What `stage` charges for a skill held under `key` at `fingerprint` with files of these content sizes. */
export function skillCost(key: string, fingerprint: string, fileSizes: number[]): number {
  return ENTRY_OVERHEAD_BYTES + 2 * (key.length + fingerprint.length)
    + fileSizes.reduce((n, size) => n + size + FILE_OVERHEAD_BYTES, 0);
}

/**
 * What `stage` did: `hit` served the held copy, `joined` waited for another
 * caller's identical download in flight, `downloaded` ran `download` itself.
 */
export type StageOutcome = "hit" | "joined" | "downloaded";

/**
 * Fills `dir` with the skill. Resolves true when the result is a usable skill
 * that may be cached; false (for example no SKILL.md) is returned to the caller
 * as downloaded but never held, so a broken skill keeps reporting itself.
 */
export type SkillDownload = (dir: string) => Promise<boolean>;

export class SkillCache {
  /** Insertion order is recency order: a hit re-inserts, eviction takes the first. */
  private entries = new Map<string, Entry>();
  private held = 0;
  /** Downloads in flight, by key and fingerprint: callers that want the same bytes share one. */
  private flights = new Map<string, Promise<SkillFile[] | null>>();

  /**
   * @param maxBytes Upper bound on what is held, counted by `skillCost` (content
   *   plus a fixed price per file and per entry); 0 turns the cache off and every
   *   skill is downloaded as it was before the cache existed. One skill costing
   *   more than a quarter of the bound is never held.
   */
  constructor(private readonly maxBytes: number) {}

  get enabled(): boolean { return this.maxBytes > 0; }

  /** Cost currently held, in the bound's own units (test and diagnostics). */
  get size(): number { return this.held; }

  clear(): void {
    this.entries.clear();
    this.held = 0;
  }

  /**
   * Put the skill `key` at `fingerprint` into `dir`, downloading it only when
   * no copy of exactly that fingerprint is held or on its way.
   *
   * `fingerprint` is what the source reports NOW, read by the caller for this
   * call: a null means the caller could not tell, and the skill is downloaded.
   */
  async stage(key: string, fingerprint: string | null, dir: string, download: SkillDownload): Promise<StageOutcome> {
    fs.mkdirSync(dir, { recursive: true });
    // A directory that already has files has had another tool's skill of the
    // same name written into it. What a snapshot of it would hold is not this
    // skill's, so it is neither served from nor added to the cache.
    if (!this.enabled || !fingerprint || fs.readdirSync(dir).length > 0) {
      await download(dir);
      return "downloaded";
    }

    const held = this.entries.get(key);
    if (held && held.fingerprint === fingerprint) {
      this.entries.delete(key);
      this.entries.set(key, held);
      writeFiles(held.files, dir);
      return "hit";
    }

    // Followers share a download only of the SAME fingerprint. One that has
    // just read a newer one does not wait for an older read to finish and take
    // its bytes: that would hand it content from before an upsert it can see.
    const flightKey = `${key}\n${fingerprint}`;
    const running = this.flights.get(flightKey);
    if (running) {
      const files = await running.catch(() => null);
      if (files) {
        writeFiles(files, dir);
        return "joined";
      }
      // The download it waited for failed or was not cacheable: do its own.
      await download(dir);
      return "downloaded";
    }

    const flight = (async (): Promise<SkillFile[] | null> => {
      if (!(await download(dir))) return null;
      const read = readFiles(dir, this.maxBytes / 4 - skillCost(key, fingerprint, []));
      if (!read) return null;
      this.admit(key, { fingerprint, files: read.files, size: skillCost(key, fingerprint, read.sizes) });
      return read.files;
    })();
    this.flights.set(flightKey, flight);
    try {
      await flight;
    } finally {
      this.flights.delete(flightKey);
    }
    return "downloaded";
  }

  private admit(key: string, entry: Entry): void {
    const prior = this.entries.get(key);
    if (prior) {
      this.held -= prior.size;
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.held += entry.size;
    // The newest entry is last in order and fits on its own (readFiles refuses
    // anything over a quarter of the bound), so this stops before reaching it.
    for (const [k, e] of this.entries) {
      if (this.held <= this.maxBytes) break;
      this.entries.delete(k);
      this.held -= e.size;
    }
  }
}

/**
 * Every regular file under `dir`, or null when what they cost (content plus
 * `FILE_OVERHEAD_BYTES` each) is more than `limit`. Stops counting at the limit,
 * so a directory of a million files is refused after reading names, not bytes.
 */
function readFiles(dir: string, limit: number): { files: SkillFile[]; sizes: number[] } | null {
  const found: Array<{ full: string; size: number }> = [];
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(full).size;
      total += size + FILE_OVERHEAD_BYTES;
      if (total > limit) return null;
      found.push({ full, size });
    }
  }
  const files = found.map(({ full }) => ({ rel: path.relative(dir, full), bytes: fs.readFileSync(full) }));
  return { files, sizes: files.map((f) => f.bytes.length) };
}

function writeFiles(files: SkillFile[], dir: string): void {
  for (const f of files) {
    const out = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.bytes);
  }
}

/** The process-wide cache every skill download goes through. */
export const skillCache = new SkillCache(SKILL_CACHE_MAX_BYTES);
