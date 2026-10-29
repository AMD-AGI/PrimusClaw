// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session bound to a repository: make `/workspace/<name>` a git working tree
 * of it when the sandbox opens, and tell the agent what it is standing in.
 *
 * Runs once per turn of a bound session, right after the sandbox is attached and
 * before the model is asked anything, through the same Hands `bash` tool the
 * agent itself uses. Three states of `/workspace/<name>`, three actions:
 *
 *   absent               clone (into a hidden sibling first, moved into place only
 *                        when it is whole, so a clone that is killed leaves nothing
 *                        that looks like a repository)
 *   has a .git           a restored snapshot, or a turn in a sandbox that is still
 *                        up: fetch, and nothing else. The branch is NOT changed and
 *                        nothing is merged or reset, so a commit, a branch or an
 *                        uncommitted edit made earlier is exactly as it was left
 *   files but no .git    a snapshot taken before `.git` was carried with it: the
 *                        repository's `.git` is placed beside the files and the index
 *                        rebuilt from it, so the files stay, as local changes
 *
 * Credentials: none are handled here. The sandbox's global git config gets
 * `credential.helper = !gh auth git-credential`, which asks the `gh` the sandbox
 * already has for the user's token at the moment git needs one (the token is the
 * user's own `GH_TOKEN` environment variable, which this code never reads). The url
 * is checked to carry no credential, the command lines carry no token, and the
 * remote that ends up in `.git/config` is the plain https url. That is what lets a
 * plain `git push` work later without a token ever being typed.
 *
 * A failure here is never the run's failure: every step answers with a reason,
 * and the reason goes into the prompt block, so the agent can tell the user what
 * is wrong instead of the turn dying before it starts.
 */
import { parseSessionRepo, sessionRepoDirName, type SessionRepo } from "@claw/protocol";
import { redactSecrets } from "@claw/utils";
import pino from "pino";

const logger = pino({ name: "repo-binding" });

/** The instruction files read from the repository root, in the order they are given to the model. */
export const REPO_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Everything taken from those files together, in bytes. */
export const REPO_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
export const REPO_TRUNCATION_MARKER = "\n[... truncated: the repository's instructions are longer than 32 KB; read the file for the rest ...]";
/** What git is told to ask for a credential. A command, not a secret. */
export const GIT_CREDENTIAL_HELPER = "!gh auth git-credential";
/** Hands' foreground ceiling; a clone that needs longer fails with that reason and the agent is told. */
const CLONE_TIMEOUT_SEC = 100;
const GIT_TIMEOUT_SEC = 60;
const REASON_MAX_CHARS = 300;

export interface RepoHands {
  callToolFull(
    name: string, args: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
}

export type RepoState = "cloned" | "adopted" | "present" | "failed";

export interface RepoInstruction { file: string; text: string; truncated: boolean }

export interface RepoBinding {
  /** The url as validated: no credential, so it is safe to show and to log. */
  url: string;
  /** The branch the session asked for, or null for the remote's default. */
  requestedBranch: string | null;
  /** `<root>/<name>`. */
  path: string;
  state: RepoState;
  /** Why `state` is "failed". */
  failure: string | null;
  /** Current branch of the working tree; null when detached or unknown. */
  branch: string | null;
  head: string | null;
  /** Paths with changes (modified, staged or untracked); null when unknown. */
  changed: number | null;
  /** Non-fatal things the agent should know, in words. */
  notes: string[];
  instructions: RepoInstruction[];
}

export interface BindOptions {
  /** Where working trees live. `/workspace`; tests point it elsewhere. */
  root?: string;
  /**
   * Where the note that this sandbox has already bound the repository is kept.
   * `/tmp`, which a new sandbox does not have, and which is not in the snapshot.
   */
  stateDir?: string;
  signal?: AbortSignal;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Scrub what a git failure may echo: a url with userinfo, and anything shaped like a token. */
export function scrubReason(text: string): string {
  const noUserinfo = text.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1<redacted>@");
  return redactSecrets(noUserinfo).text;
}

/**
 * The few lines of a failed command worth showing. git says what is wrong in its
 * `fatal:` / `error:` / `remote:` lines and pads the rest with advice, so those come
 * first; a command that prints neither gets the end of its stderr.
 */
function reasonOf(out: string): string {
  const m = /(?:^|\n)stderr:\s*([\s\S]*)$/.exec(out);
  const lines = (m ? m[1] : out).replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const said = lines.filter((l) => /^(fatal|error|remote):/i.test(l));
  const text = (said.length ? said.slice(0, 3) : lines.slice(-3)).join(" | ") || out.trim() || "no output";
  const clean = scrubReason(text);
  return clean.length > REASON_MAX_CHARS ? `${clean.slice(0, REASON_MAX_CHARS)}...` : clean;
}

async function sh(
  hands: RepoHands, command: string, timeoutSec: number, signal?: AbortSignal,
): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await hands.callToolFull("bash", { command, timeout: timeoutSec }, signal);
    return { ok: !r.isError, out: r.text };
  } catch (err) {
    // The sandbox is unreachable or the call was cut. Not thrown further: the
    // turn goes on, and the reason is what the agent is told.
    return { ok: false, out: `stderr: could not run the command in the sandbox: ${(err as Error)?.message ?? err}` };
  }
}

function marker(out: string, key: string): string | null {
  const m = new RegExp(`^CLAW_REPO_${key}=(.*)$`, "m").exec(out);
  return m ? m[1].trim() : null;
}

/** Two urls name the same repository when they differ only by case, a trailing `.git` or `/`, or userinfo. */
export function sameRepoUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/^(https?:\/\/)[^/@]*@/i, "$1").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return norm(a) === norm(b);
}

// --- the commands -------------------------------------------------------------------
// Every one is built from the validated name, url and branch, each also single-quoted.

const GIT_ENV = "export GIT_TERMINAL_PROMPT=0;";

// The origin is read as stored (`config --get`), not with `remote get-url`: that one
// applies the user's `url.<base>.insteadOf` rewrites, so a sandbox that rewrites
// https to ssh would see its own clone as somebody else's.
function credentialAndProbe(dir: string, boundMarker: string): string {
  const helper = shq(GIT_CREDENTIAL_HELPER);
  return [
    // Idempotent: a second turn in the same sandbox adds nothing.
    `if git config --global --get-all credential.helper 2>/dev/null | grep -qxF ${helper} || git config --global --add credential.helper ${helper} 2>/dev/null; then echo CLAW_REPO_CRED=ok; else echo CLAW_REPO_CRED=failed; fi;`,
    `D=${shq(dir)};`,
    `if [ -e "$D/.git" ]; then echo CLAW_REPO_STATE=git; echo "CLAW_REPO_ORIGIN=$(git -C "$D" config --get remote.origin.url 2>/dev/null)";`,
    `elif [ -e "$D" ] && [ -n "$(ls -A "$D" 2>/dev/null)" ]; then echo CLAW_REPO_STATE=occupied;`,
    `else echo CLAW_REPO_STATE=absent; fi;`,
    `if [ -e ${shq(boundMarker)} ]; then echo CLAW_REPO_BOUND=yes; else echo CLAW_REPO_BOUND=no; fi`,
  ].join(" ");
}

function cloneCommand(dir: string, tmp: string, url: string, boundMarker: string): string {
  return [
    GIT_ENV, `D=${shq(dir)}; T=${shq(tmp)};`,
    // An empty directory is in the way of the move; a partial one from a clone that was killed is not wanted.
    `rm -rf "$T"; rmdir "$D" 2>/dev/null;`,
    `git clone --quiet -- ${shq(url)} "$T" && mv "$T" "$D" && touch ${shq(boundMarker)}`,
    `|| { rc=$?; rm -rf "$T"; exit $rc; }`,
  ].join(" ");
}

function adoptCommand(dir: string, tmp: string, url: string, boundMarker: string): string {
  return [
    GIT_ENV, `D=${shq(dir)}; T=${shq(tmp)};`,
    `rm -rf "$T";`,
    // The repository's .git beside the files that are already there; the index is
    // rebuilt from HEAD without touching the working tree, so the files are kept
    // and show up as changes against it.
    `git clone --quiet --no-checkout -- ${shq(url)} "$T" && mv "$T/.git" "$D/.git" && rm -rf "$T" && git -C "$D" reset --quiet && touch ${shq(boundMarker)}`,
    `|| { rc=$?; rm -rf "$T"; exit $rc; }`,
  ].join(" ");
}

function fetchCommand(dir: string, boundMarker: string): string {
  return `${GIT_ENV} git -C ${shq(dir)} fetch --quiet origin && touch ${shq(boundMarker)}`;
}

/** Switch a fresh clone to the requested branch, if the remote has it. Only ever run right after a clone. */
function branchCommand(dir: string, branch: string): string {
  return [
    `D=${shq(dir)}; B=${shq(branch)};`,
    `if [ "$(git -C "$D" branch --show-current)" = "$B" ]; then echo CLAW_REPO_BRANCH_RESULT=already;`,
    `elif git -C "$D" rev-parse --verify --quiet "refs/remotes/origin/$B" >/dev/null; then`,
    `if git -C "$D" checkout --quiet -B "$B" "origin/$B"; then echo CLAW_REPO_BRANCH_RESULT=switched; else echo CLAW_REPO_BRANCH_RESULT=failed; fi;`,
    `else echo CLAW_REPO_BRANCH_RESULT=missing; fi`,
  ].join(" ");
}

function statusCommand(dir: string): string {
  const d = shq(dir);
  return [
    `echo "CLAW_REPO_BRANCH=$(git -C ${d} branch --show-current 2>/dev/null)";`,
    `echo "CLAW_REPO_HEAD=$(git -C ${d} rev-parse --short HEAD 2>/dev/null)";`,
    `echo "CLAW_REPO_CHANGED=$(git -C ${d} status --porcelain 2>/dev/null | wc -l | tr -d ' ')"`,
  ].join(" ");
}

const FILE_HEADER = "@@CLAW-REPO-FILE ";
const FILE_END = "@@CLAW-REPO-END@@";

/**
 * Read each instruction file, as at most the cap plus one byte, so an over-long
 * one is recognised without being pulled whole. A file that is a symlink to
 * somewhere outside the repository is not read: the repository is somebody
 * else's text, and a link to a file of the sandbox's own would put it in the prompt.
 */
function instructionsCommand(dir: string): string {
  const cap = REPO_INSTRUCTIONS_MAX_BYTES + 1;
  const parts = REPO_INSTRUCTION_FILES.map((f) => [
    `f="$D/${f}";`,
    `if [ -f "$f" ]; then rp=$(realpath -e -- "$f" 2>/dev/null);`,
    `case "$rp" in "$RD"/*) echo "${FILE_HEADER}${f}@@"; head -c ${cap} -- "$f"; echo; echo "${FILE_END}";; esac; fi;`,
  ].join(" "));
  return [`D=${shq(dir)}; RD=$(realpath -e -- "$D" 2>/dev/null);`, ...parts].join(" ");
}

/** Cut text to a byte budget on a character boundary; the second value says whether anything was cut. */
export function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let cut = buf.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  // A multi-byte character cut in half decodes to U+FFFD at the end.
  while (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * The instruction files out of one `instructionsCommand` output, sharing one byte
 * budget. What is rendered, truncation marker included, never exceeds the budget.
 */
export function parseInstructions(out: string, budget = REPO_INSTRUCTIONS_MAX_BYTES): RepoInstruction[] {
  const found: Array<{ file: string; text: string }> = [];
  const re = new RegExp(`^${FILE_HEADER}([^@\\n]+)@@\\n([\\s\\S]*?)\\n?${FILE_END}$`, "gm");
  for (let m = re.exec(out); m; m = re.exec(out)) {
    // The command writes one newline after `head`, which is not the file's.
    found.push({ file: m[1], text: m[2].replace(/\n$/, "") });
  }
  const markerBytes = Buffer.byteLength(REPO_TRUNCATION_MARKER, "utf8");
  const result: RepoInstruction[] = [];
  let left = budget;
  const seen = new Set<string>();
  for (const { file, text } of found) {
    if (!text.trim()) continue;
    // CLAUDE.md that is a link to, or a copy of, AGENTS.md is the same instructions once.
    if (seen.has(text)) continue;
    seen.add(text);
    if (Buffer.byteLength(text, "utf8") <= left) {
      result.push({ file, text, truncated: false });
      left -= Buffer.byteLength(text, "utf8");
      continue;
    }
    if (left <= markerBytes) {
      result.push({ file, text: "", truncated: true });
      left = 0;
      continue;
    }
    const clipped = clipUtf8(text, left - markerBytes);
    result.push({ file, text: clipped.text, truncated: true });
    left = 0;
  }
  return result;
}

function emptyBinding(url: string, requestedBranch: string | null, path: string): RepoBinding {
  return {
    url, requestedBranch, path, state: "failed", failure: null,
    branch: null, head: null, changed: null, notes: [], instructions: [],
  };
}

/**
 * Set the bound repository up in the sandbox. Never throws: the result says what
 * happened, including that it did not work.
 */
export async function bindRepo(hands: RepoHands, raw: unknown, options: BindOptions = {}): Promise<RepoBinding> {
  const root = (options.root ?? "/workspace").replace(/\/+$/, "");
  const parsed = parseSessionRepo(raw);
  const repo: SessionRepo | null = parsed.ok ? parsed.repo : null;
  const name = repo ? sessionRepoDirName(repo) : null;
  if (!repo || !name) {
    // The reason is the check's own words, which never contain the value.
    const failed = emptyBinding("(not accepted)", null, root);
    failed.failure = parsed.ok ? "no repository was given" : parsed.error;
    logger.warn({ reason: failed.failure }, "repo.binding_refused");
    return failed;
  }
  const dir = `${root}/${name}`;
  const tmp = `${root}/.claw-clone-${name}`;
  const boundMarker = `${(options.stateDir ?? "/tmp").replace(/\/+$/, "")}/.claw-repo-bound-${name}`;
  const b = emptyBinding(repo.url, repo.branch ?? null, dir);
  const started = Date.now();
  const { signal } = options;

  const probe = await sh(hands, credentialAndProbe(dir, boundMarker), GIT_TIMEOUT_SEC, signal);
  const state = marker(probe.out, "STATE");
  if (!probe.ok || !state) {
    b.failure = `the sandbox could not inspect ${dir}: ${reasonOf(probe.out)}`;
    return finish(b, started);
  }
  if (marker(probe.out, "CRED") !== "ok") {
    b.notes.push("git could not be set up to use the signed-in GitHub account, so `git push` and private repositories may ask for a login that cannot be given");
  }

  if (state === "git") {
    const origin = marker(probe.out, "ORIGIN") ?? "";
    if (!sameRepoUrl(origin, repo.url)) {
      // Somebody else's checkout of a repository that happens to share a name. Left exactly as it is.
      b.failure = `${dir} already holds a different repository (its origin is ${scrubReason(origin) || "unknown"}), so it was left untouched`;
      return finish(b, started);
    }
    b.state = "present";
    if (marker(probe.out, "BOUND") !== "yes") {
      const f = await sh(hands, fetchCommand(dir, boundMarker), CLONE_TIMEOUT_SEC, signal);
      if (!f.ok) b.notes.push(`git fetch failed (${reasonOf(f.out)}); the checkout is as it was left`);
    }
  } else if (state === "occupied") {
    const a = await sh(hands, adoptCommand(dir, tmp, repo.url, boundMarker), CLONE_TIMEOUT_SEC, signal);
    if (!a.ok) {
      b.failure = `${dir} already has files and is not a git repository, and attaching the repository to them failed: ${reasonOf(a.out)}`;
      return finish(b, started);
    }
    b.state = "adopted";
    b.notes.push(`${dir} already had files and no .git (a snapshot from before .git was kept): the repository's .git was attached on its default branch and those files show as local changes`);
    if (b.requestedBranch) b.notes.push(`branch ${b.requestedBranch} was not checked out because the files are in the way; the checkout is on the remote's default branch`);
  } else {
    const c = await sh(hands, cloneCommand(dir, tmp, repo.url, boundMarker), CLONE_TIMEOUT_SEC, signal);
    if (!c.ok) {
      b.failure = `git clone of ${repo.url} failed: ${reasonOf(c.out)}`;
      return finish(b, started);
    }
    b.state = "cloned";
    if (b.requestedBranch) {
      const r = await sh(hands, branchCommand(dir, b.requestedBranch), GIT_TIMEOUT_SEC, signal);
      const result = marker(r.out, "BRANCH_RESULT");
      if (result === "missing") b.notes.push(`branch ${b.requestedBranch} does not exist on the remote; the checkout is on the remote's default branch`);
      else if (result === "failed" || !r.ok) b.notes.push(`switching to branch ${b.requestedBranch} failed (${reasonOf(r.out)}); the checkout is on the remote's default branch`);
    }
  }

  const s = await sh(hands, statusCommand(dir), GIT_TIMEOUT_SEC, signal);
  b.branch = marker(s.out, "BRANCH") || null;
  b.head = marker(s.out, "HEAD") || null;
  const changed = Number(marker(s.out, "CHANGED"));
  b.changed = Number.isFinite(changed) ? changed : null;
  if (b.state === "present" && b.requestedBranch && b.branch !== b.requestedBranch) {
    b.notes.push(`the session was started on branch ${b.requestedBranch}; this checkout is on ${b.branch ?? "a detached HEAD"}, where the earlier work was left, and it was not switched`);
  }

  const i = await sh(hands, instructionsCommand(dir), GIT_TIMEOUT_SEC, signal);
  if (i.ok) b.instructions = parseInstructions(i.out);
  return finish(b, started);
}

function finish(b: RepoBinding, started: number): RepoBinding {
  // The url was checked to carry no credential; a failure reason was scrubbed.
  logger.info({
    url: b.url, state: b.state, branch: b.branch, notes: b.notes.length,
    failure: b.failure ? scrubReason(b.failure) : undefined, ms: Date.now() - started,
  }, "repo.bound");
  return b;
}

// --- the prompt block ---------------------------------------------------------------

function describeChanges(changed: number | null): string {
  if (changed === null) return "";
  return changed === 0 ? "the working tree is clean" : `${changed} path${changed === 1 ? "" : "s"} with uncommitted changes`;
}

/**
 * What the model is told about the repository. A block of its own, appended to the
 * user turn, so a session with no binding is given nothing at all.
 */
export function renderRepoBlock(b: RepoBinding): string {
  const lines: string[] = ["[Repository]"];
  const branchAsked = b.requestedBranch ? `, branch ${b.requestedBranch}` : "";
  if (b.state === "failed") {
    lines.push(`- This session is bound to ${b.url}${branchAsked}, but setting up the working tree failed: ${b.failure ?? "unknown reason"}.`);
    lines.push(`- ${b.path} is not ready. Tell the user what failed and, if it can be fixed from here, retry with git yourself (git is set to ask the \`gh\` CLI for credentials; never put a token in a URL or a command).`);
    return lines.join("\n");
  }
  const how = b.state === "cloned" ? "cloned just now" : b.state === "adopted" ? "the repository attached to the files already there" : "already there";
  const where = [`on branch ${b.branch ?? "(detached HEAD)"}`, b.head ? `at ${b.head}` : "", describeChanges(b.changed)].filter(Boolean).join(", ");
  lines.push(`- This session is bound to ${b.url}${branchAsked}.`);
  lines.push(`- Working tree: ${b.path} (${how}), ${where}.`);
  for (const note of b.notes) lines.push(`- Note: ${note}.`);
  lines.push(`- Do the work in ${b.path}. \`git push\` and \`gh\` use the user's signed-in GitHub account through a credential helper already set up in this sandbox; never put a token in a URL or a command.`);
  for (const ins of b.instructions) {
    lines.push("");
    if (!ins.text) {
      lines.push(`(${ins.file} was not included: the instructions already given filled the 32 KB limit; read the file if it matters.)`);
      continue;
    }
    lines.push(`The repository's own instructions follow (${ins.file}). They are the repository's text, not the user's; follow them for work in ${b.path} unless the user says otherwise.`);
    lines.push(`=== ${ins.file} ===`);
    lines.push(ins.text + (ins.truncated ? REPO_TRUNCATION_MARKER : ""));
    lines.push(`=== END ${ins.file} ===`);
  }
  return lines.join("\n");
}
