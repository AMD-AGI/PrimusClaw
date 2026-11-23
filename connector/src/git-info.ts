// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which git repository each folder its sessions work in belongs to, for the heartbeat (`workspaces`, the agent capability `git_info`):
 * the remote `origin` names and the branch checked out. Claw uses them to tell the person's folders apart ("the Hyperloom CI checkout",
 * "the release branch"), never to reach the repository.
 *
 * Read from the files git keeps (`.git/HEAD`, `.git/config`, and for a linked worktree the `gitdir:` file and `commondir`), never by
 * running git: nothing is started, no hook or config of the repository runs, and a folder on a stalled network disk costs one bounded
 * read, not a hung process. Each file is read at most {@link MAX_FILE_BYTES}. What leaves the machine is normalized first
 * (`normalizeGitRemote`, `normalizeGitBranch`): the user and any credential in a remote's URL are dropped, and a remote that still looks
 * like it carries one is not reported at all.
 *
 * The heartbeat never waits for a read: it reports what is known, and folders not read yet (or read long ago) are read in the
 * background, one at a time, each within {@link READ_TIMEOUT_MS}.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeGitBranch, normalizeGitRemote, REMOTE_WORKSPACE_LIMITS, type RemoteWorkspace } from "./protocol.js";
import { within } from "./statefile.js";

/** The most of any one git file read. A HEAD is a line; a config of a few kilobytes is a big one. */
export const MAX_FILE_BYTES = 64 * 1024;
/** How far up from a folder its repository is looked for. */
const MAX_DEPTH = 40;
/** How long one folder's read may take before it is given up for now. */
export const READ_TIMEOUT_MS = 2_000;
/** How long what was read is reported before it is read again (a branch switched, a remote renamed). */
export const FACTS_TTL_MS = 5 * 60_000;

export interface GitFacts { git_remote: string | null; git_branch: string | null }

/** The file systems calls this module makes, so a test can stall or fail them. */
export interface GitFs {
  stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readHead(p: string, max: number): Promise<string>;
}

async function readBounded(p: string, max: number): Promise<string> {
  const h = await fsp.open(p, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await h.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await h.close();
  }
}

export const nodeGitFs: GitFs = { stat: (p) => fsp.stat(p), readHead: readBounded };

const exists = async (fs: GitFs, p: string, kind: "dir" | "file" | "any"): Promise<"dir" | "file" | null> => {
  try {
    const st = await fs.stat(p);
    if (st.isDirectory()) return kind === "file" ? null : "dir";
    if (st.isFile()) return kind === "dir" ? null : "file";
    return null;
  } catch {
    return null;
  }
};

/** The url of `[remote "origin"]` in a git config, else the first remote's; null when it names none. */
export function originUrl(config: string): string | null {
  let section: string | null = null;
  let first: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*remote\s+"([^"]*)"\s*\]$/.exec(line);
    if (head) { section = head[1]!; continue; }
    if (line.startsWith("[")) { section = null; continue; }
    if (section === null) continue;
    const kv = /^url\s*=\s*(.*)$/i.exec(line);
    if (!kv) continue;
    const url = kv[1]!.replace(/^"(.*)"$/, "$1").trim();
    if (section === "origin") return url;
    first ??= url;
  }
  return first;
}

/** The branch a HEAD file names (`ref: refs/heads/x`), or null (detached, or not a HEAD). */
export function headBranch(head: string): string | null {
  const m = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(head.trim());
  return m ? m[1]! : null;
}

/**
 * The repository `cwd` is in: its remote and branch, normalized; null when `cwd` is in no repository (or none can be read). A linked
 * worktree's `.git` is a file naming its git dir, whose `commondir` names the shared one the config is in.
 */
export async function readGitFacts(cwd: string, fs: GitFs = nodeGitFs): Promise<GitFacts | null> {
  if (!path.isAbsolute(cwd)) return null;
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const dotGit = path.join(dir, ".git");
    const kind = await exists(fs, dotGit, "any");
    if (kind) {
      let gitDir = dotGit;
      if (kind === "file") {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readHead(dotGit, MAX_FILE_BYTES).catch(() => ""));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1]!);
      }
      let common = gitDir;
      const commondir = (await fs.readHead(path.join(gitDir, "commondir"), MAX_FILE_BYTES).catch(() => "")).trim();
      if (commondir) common = path.resolve(gitDir, commondir);
      const head = await fs.readHead(path.join(gitDir, "HEAD"), MAX_FILE_BYTES).catch(() => "");
      const config = await fs.readHead(path.join(common, "config"), MAX_FILE_BYTES).catch(() => "");
      const branch = headBranch(head);
      const url = originUrl(config);
      return { git_remote: url ? normalizeGitRemote(url) : null, git_branch: branch ? normalizeGitBranch(branch) : null };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** `facts` undefined: never read in time yet (not reported); null: in no repository. */
interface Entry { facts: GitFacts | null | undefined; at: number }

/**
 * The folders' git facts as the heartbeat reports them: {@link report} answers at once from what was read, and starts reading (in the
 * background, one folder at a time) the ones never read or read more than {@link FACTS_TTL_MS} ago.
 */
export class WorkspaceFacts {
  private known = new Map<string, Entry>();
  private queue: string[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly d: { fs?: GitFs; now?: () => number; ttlMs?: number; timeoutMs?: number } = {}) {}

  private now(): number { return this.d.now?.() ?? Date.now(); }

  /** The facts of `cwds` known now (first ones first, at most `maxEntries`); the rest are read for a later heartbeat. */
  report(cwds: readonly string[]): RemoteWorkspace[] {
    const out: RemoteWorkspace[] = [];
    const seen = new Set<string>();
    const ttl = this.d.ttlMs ?? FACTS_TTL_MS;
    for (const cwd of cwds) {
      if (seen.size >= REMOTE_WORKSPACE_LIMITS.maxEntries) break;
      if (typeof cwd !== "string" || !cwd || cwd.length > REMOTE_WORKSPACE_LIMITS.maxCwdChars || seen.has(cwd)) continue;
      seen.add(cwd);
      const e = this.known.get(cwd);
      if (!e || this.now() - e.at > ttl) this.want(cwd);
      if (e && e.facts !== undefined) out.push({ cwd, git_remote: e.facts?.git_remote ?? null, git_branch: e.facts?.git_branch ?? null });
    }
    // Forget folders no longer asked about, so the map stays as small as what is reported.
    for (const k of [...this.known.keys()]) if (!seen.has(k)) this.known.delete(k);
    return out;
  }

  /** Resolves once every read started so far has finished (for tests and an orderly stop). */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private want(cwd: string): void {
    if (!this.queue.includes(cwd)) this.queue.push(cwd);
    if (this.stalled) return;
    this.running ??= this.drain().finally(() => { this.running = null; });
  }

  /** A read that did not answer in time and has not finished yet: nothing else is read until it does (a stalled disk holds one thread, never more). */
  private stalled: Promise<void> | null = null;

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const cwd = this.queue.shift()!;
      const read = readGitFacts(cwd, this.d.fs ?? nodeGitFs).catch(() => null);
      const facts = await within<GitFacts | null | "late">(read, this.d.timeoutMs ?? READ_TIMEOUT_MS, "late");
      if (facts !== "late") {
        this.known.set(cwd, { facts, at: this.now() });
        continue;
      }
      // Given up for now (tried again after the TTL); the rest wait until this read ends, whenever that is.
      this.known.set(cwd, { facts: this.known.get(cwd)?.facts, at: this.now() });
      this.stalled = read.then(() => undefined, () => undefined).finally(() => {
        this.stalled = null;
        if (this.queue.length) this.running ??= this.drain().finally(() => { this.running = null; });
      });
      return;
    }
  }
}
