// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session's sandbox has changed: the git work trees under /workspace, as a
 * summary (files, +/-) and, for one file, a patch.
 *
 * Computed live, in the sandbox, by `git` through Hands. Two shell scripts that are
 * written here and take no text from the caller, and parsers for what they print.
 * Nothing the caller sends is ever put in a command except a path that this same
 * listing produced, single-quoted, after `--`, with literal pathspecs; see
 * {@link resolvePatchTarget}.
 *
 * The scripts print only ASCII: every path is hex-encoded and every block of git's
 * machine output (`-z`, NUL separated) is base64, so a file name with a newline, a
 * quote or a NUL in it cannot forge a line of the framing, and nothing needs
 * unquoting. Git is told not to take its optional index lock, so this never
 * collides with the agent's own git, and not to run an fsmonitor hook, an external
 * diff or a text conversion from the repository's config.
 */
import { redactPublicJson } from "../events/redaction.js";

/** The directory the sandbox keeps its files in. */
export const WORKSPACE_ROOT = "/workspace";
/** Most repositories listed: the search is depth-limited and this bounds the rest. */
export const CHANGES_MAX_REPOS = 20;
/** Most files listed per repository; past it `truncated` is true. */
export const CHANGES_MAX_FILES = 200;
/** An untracked file larger than this is counted as added with unknown lines. */
export const UNTRACKED_COUNT_MAX_BYTES = 5 * 1024 * 1024;
/** Cap on an untracked file's line count. */
export const LINE_COUNT_CAP = 1_000_000;
/** The largest patch returned, in bytes. */
export const PATCH_MAX_BYTES = 64 * 1024;
/** Longest path accepted from a caller. */
export const PATH_PARAM_MAX = 1024;
/** What the script reads of git's status / numstat output, per repository and per stream, before it stops. */
export const GIT_OUTPUT_MAX_BYTES = 400_000;
/**
 * Characters of git output (after base64) the whole summary may print. Hands cuts a command's
 * output at 10 MB, and a cut stream loses its last repositories silently; past this the script
 * says there are more and stops, so what is printed is whole.
 */
export const SUMMARY_OUTPUT_BUDGET = 6_000_000;

export type ChangeStatus = "M" | "A" | "D" | "R" | "?";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface ChangesRepo {
  path: string;
  branch: string | null;
  /** Short sha; empty for a repository with no commit yet. */
  head: string;
  truncated: boolean;
  /**
   * Over everything known, not only the listed files. When `truncated` is true
   * these are lower bounds: files past the cap and untracked files past the
   * counting cap are not in them.
   */
  totals: { files: number; additions: number; deletions: number };
  files: ChangedFile[];
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** git, in one repository, told not to run anything the repository's config names. */
const GIT_FN = `g() { git -c core.fsmonitor=false -c core.quotePath=false -C "$d" "$@"; };`;
const ENV = "export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1;";
/** The commit to diff against: HEAD, or the empty tree for a repository with no commit yet. */
const BASE = `if g rev-parse --verify -q HEAD >/dev/null 2>&1; then base=HEAD; else base=$(g hash-object -t tree /dev/null 2>/dev/null); fi;`;
const HEX = `od -An -v -tx1 | tr -d ' \\n'`;

/**
 * The summary script. No input but the root, which is a constant of this module in
 * production and a temporary directory in tests.
 */
export function summaryScript(root: string = WORKSPACE_ROOT, budget: number = SUMMARY_OUTPUT_BUDGET): string {
  const hexPath = `$(printf %s "$d" | ${HEX})`;
  return [
    ENV,
    `R=${shq(root)};`,
    // Depth 3 from the root: a work tree at the root, or one or two levels down.
    // Dependency and cache trees are not entered.
    `find "$R" -maxdepth 3 \\( -name node_modules -o -name .skills -o -name .cache \\) -prune -o -name .git -print0 2>/dev/null`,
    `| head -z -n ${CHANGES_MAX_REPOS + 1} | { tot=0; while IFS= read -r -d '' gd; do`,
    `d=\${gd%/.git}; ${GIT_FN}`,
    `printf '@@REPO %s\\n' "${hexPath}";`,
    `printf '@@HEAD %s\\n' "$(g rev-parse --short HEAD 2>/dev/null)";`,
    `printf '@@BRANCH %s\\n' "$(g branch --show-current 2>/dev/null)";`,
    BASE,
    `st=$(g status --porcelain=v1 -z --untracked-files=no 2>/dev/null | head -c ${GIT_OUTPUT_MAX_BYTES} | base64 -w0);`,
    `ns=$(g diff --numstat -z -M --no-ext-diff --no-textconv "$base" -- 2>/dev/null | head -c ${GIT_OUTPUT_MAX_BYTES} | base64 -w0);`,
    `printf '@@STATUS %s\\n' "$st"; printf '@@NUMSTAT %s\\n' "$ns"; tot=$((tot + \${#st} + \${#ns}));`,
    // Untracked files: counted as added, by lines, unless too large or binary.
    `i=0; g ls-files --others --exclude-standard -z 2>/dev/null | head -z -n ${CHANGES_MAX_FILES + 1} | while IFS= read -r -d '' f; do`,
    `i=$((i+1)); if [ "$i" -gt ${CHANGES_MAX_FILES} ]; then printf '@@UMORE\\n'; break; fi;`,
    `hex=$(printf %s "$f" | ${HEX});`,
    `sz=$(stat -c %s -- "$d/$f" 2>/dev/null || echo 0);`,
    `if [ "$sz" -gt ${UNTRACKED_COUNT_MAX_BYTES} ] 2>/dev/null; then n='?';`,
    `else n=$(g diff --no-index --numstat -- /dev/null "$f" 2>/dev/null | head -n 1 | cut -f1); [ -n "$n" ] || n='?'; fi;`,
    `printf '@@U %s %s\\n' "$hex" "$n"; done;`,
    `printf '@@END\\n'; if [ "$tot" -gt ${budget} ]; then printf '@@MORE\\n'; break; fi; done; }`,
  ].join(" ");
}

/**
 * The patch script for one file of one repository, both already matched against
 * the listing: the output is `@@PATCH <base64>` and `@@END`. Single-quoted, after
 * `--`, with literal pathspecs and no external diff or text conversion.
 */
export function patchScript(repoPath: string, filePath: string, untracked: boolean, origPath?: string): string {
  const git = `git -c core.fsmonitor=false -c core.quotePath=false -C ${shq(repoPath)}`;
  const flags = "--no-color --no-ext-diff --no-textconv";
  // A renamed file is shown as a rename only when git is given both of its paths.
  const paths = origPath ? `${shq(filePath)} ${shq(origPath)}` : shq(filePath);
  const diff = untracked
    ? `${git} diff --no-index ${flags} -- /dev/null ${shq(filePath)}`
    : `${git} diff ${flags} -M "$base" -- ${paths}`;
  const base = `d=${shq(repoPath)}; ${GIT_FN} ${BASE}`;
  return [
    ENV,
    untracked ? "" : base,
    `printf '@@PATCH %s\\n' "$(${diff} 2>/dev/null | head -c ${PATCH_MAX_BYTES + 4096} | base64 -w0)";`,
    `printf '@@END\\n'`,
  ].filter(Boolean).join(" ");
}

// --- parsing --------------------------------------------------------------------------

interface StatusEntry { xy: string; path: string; /** The path a rename or copy came from. */ orig?: string }
interface NumstatEntry { additions: number | null; deletions: number | null; binary: boolean }
interface ParsedRepo {
  path: string;
  head: string;
  branch: string | null;
  status: StatusEntry[];
  statusTruncated: boolean;
  numstat: Map<string, NumstatEntry>;
  untracked: Array<{ path: string; additions: number | null; binary: boolean }>;
  untrackedMore: boolean;
}

const fromB64 = (s: string): Buffer => Buffer.from(s, "base64");
const fromHex = (s: string): string | null => (/^(?:[0-9a-f]{2})*$/.test(s) ? Buffer.from(s, "hex").toString("utf8") : null);

/** A path that may be shown and used: absolute under `root`, canonical, one line. */
export function isPathUnder(root: string, p: string): boolean {
  if (!p || p.length > PATH_PARAM_MAX || /[\0\r\n]/.test(p)) return false;
  if (p !== root && !p.startsWith(`${root}/`)) return false;
  return !p.split("/").some((seg) => seg === "..") && !p.includes("//") && (p === root || !p.endsWith("/"));
}

/** `git status --porcelain=v1 -z`: `XY path NUL`, and for a rename or copy the original path follows. */
export function parseStatusZ(buf: Buffer): { entries: StatusEntry[]; partial: boolean } {
  const tokens = buf.toString("utf8").split("\0");
  // A well-formed stream ends in NUL, so the last token is empty; anything else was cut.
  const partial = tokens[tokens.length - 1] !== "";
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (tok.length < 4 || tok[2] !== " ") continue;
    const xy = tok.slice(0, 2);
    const entry: StatusEntry = { xy, path: tok.slice(3) };
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const orig = tokens[i + 1];
      if (orig) entry.orig = orig;
      i++;
    }
    entries.push(entry);
  }
  return { entries, partial };
}

/** `git diff --numstat -z`: `added TAB deleted TAB path NUL`; a rename is `added TAB deleted TAB NUL old NUL new NUL`. */
export function parseNumstatZ(buf: Buffer): Map<string, NumstatEntry> {
  const tokens = buf.toString("utf8").split("\0");
  const out = new Map<string, NumstatEntry>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      // rename / copy: the next two tokens are the old and the new path
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    const binary = m[1] === "-" && m[2] === "-";
    out.set(path, {
      additions: binary ? null : Number(m[1]),
      deletions: binary ? null : Number(m[2]),
      binary,
    });
  }
  return out;
}

/** The one-letter status of a porcelain `XY`. */
export function statusLetter(xy: string): ChangeStatus {
  if (xy === "??") return "?";
  const [x, y] = [xy[0], xy[1]];
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "A";
  if (x === "D" || y === "D") return "D";
  if (x === "A" || y === "A") return "A";
  return "M";
}

/**
 * The repositories out of one run of {@link summaryScript}. A repository whose path
 * is not under `root`, is not one clean line, or whose framing is broken is left
 * out rather than guessed at.
 */
export function parseSummary(output: string, root: string = WORKSPACE_ROOT): { repos: ParsedRepo[]; moreRepos: boolean } {
  const repos: ParsedRepo[] = [];
  let cur: ParsedRepo | null = null;
  let moreRepos = false;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@REPO ")) {
      cur = null;
      const path = fromHex(line.slice(7).trim());
      if (path !== null && isPathUnder(root, path)) {
        cur = {
          path, head: "", branch: null, status: [], statusTruncated: false,
          numstat: new Map(), untracked: [], untrackedMore: false,
        };
      }
      continue;
    }
    if (line === "@@MORE") { moreRepos = true; continue; }
    if (line === "@@END") {
      if (cur) {
        if (repos.length >= CHANGES_MAX_REPOS) moreRepos = true;
        else repos.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@HEAD ")) cur.head = /^[0-9a-f]{4,64}$/.test(line.slice(7).trim()) ? line.slice(7).trim() : "";
    else if (line.startsWith("@@BRANCH ")) cur.branch = line.slice(9).trim() || null;
    else if (line.startsWith("@@STATUS ")) {
      const buf = fromB64(line.slice(9).trim());
      const { entries, partial } = parseStatusZ(buf);
      cur.status = entries;
      cur.statusTruncated = partial || buf.length >= GIT_OUTPUT_MAX_BYTES;
    } else if (line.startsWith("@@NUMSTAT ")) {
      cur.numstat = parseNumstatZ(fromB64(line.slice(10).trim()));
    } else if (line === "@@UMORE") {
      cur.untrackedMore = true;
    } else if (line.startsWith("@@U ")) {
      const [hex, n] = line.slice(4).trim().split(" ");
      const path = fromHex(hex ?? "");
      if (path === null || path === "") continue;
      if (n === "-") cur.untracked.push({ path, additions: null, binary: true });
      else if (n !== undefined && /^\d+$/.test(n)) cur.untracked.push({ path, additions: Math.min(Number(n), LINE_COUNT_CAP), binary: false });
      else cur.untracked.push({ path, additions: null, binary: false });
    }
  }
  return { repos, moreRepos };
}

/** What the sandbox reported about a changed file, with the one thing the answer does not carry: where a rename came from. */
export type KnownFile = ChangedFile & { orig?: string };

/** The listing of one repository: every changed file, sorted, the first `CHANGES_MAX_FILES` of them shown. */
export function assembleRepo(p: ParsedRepo): { repo: ChangesRepo; known: Map<string, KnownFile> } {
  const all = new Map<string, KnownFile>();
  for (const e of p.status) {
    const ns = p.numstat.get(e.path);
    all.set(e.path, {
      path: e.path,
      status: statusLetter(e.xy),
      additions: ns ? ns.additions : null,
      deletions: ns ? ns.deletions : null,
      binary: ns ? ns.binary : false,
      ...(e.orig ? { orig: e.orig } : {}),
    });
  }
  for (const u of p.untracked) {
    if (all.has(u.path)) continue;
    all.set(u.path, { path: u.path, status: "?", additions: u.additions, deletions: u.binary ? null : 0, binary: u.binary });
  }
  const files = [...all.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let additions = 0;
  let deletions = 0;
  for (const f of files) { additions += f.additions ?? 0; deletions += f.deletions ?? 0; }
  const truncated = files.length > CHANGES_MAX_FILES || p.untrackedMore || p.statusTruncated;
  return {
    repo: {
      path: p.path,
      branch: p.branch,
      head: p.head,
      truncated,
      totals: { files: files.length + (p.untrackedMore ? 1 : 0), additions, deletions },
      // The answer carries the contract's keys and no others.
      files: files.slice(0, CHANGES_MAX_FILES).map(({ path, status, additions, deletions, binary }) => ({ path, status, additions, deletions, binary })),
    },
    known: all,
  };
}

// --- the patch form -------------------------------------------------------------------

export type PatchTarget =
  | { ok: true; repo: string; file: string; untracked: boolean; orig?: string }
  | { ok: false; status: 400 | 404; error: string };

/** One query parameter as a path: a single string, one line, not empty, not too long. */
export function pathParam(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > PATH_PARAM_MAX) return null;
  return /[\0\r\n]/.test(v) ? null : v;
}

export type PatchParams = { ok: true; repo: string; rel: string } | { ok: false; status: 400; error: string };

/**
 * The shape of a patch request, before anything is asked of the sandbox: `repo` is a
 * canonical path under the root, `file` a canonical path relative to it (or absolute
 * under it). Anything else is refused here, so a malformed request costs nothing.
 */
export function checkPatchParams(repoParam: unknown, fileParam: unknown, root: string = WORKSPACE_ROOT): PatchParams {
  const repo = pathParam(repoParam);
  const file = pathParam(fileParam);
  if (repo === null || !isPathUnder(root, repo)) return { ok: false, status: 400, error: "invalid_repo" };
  if (file === null) return { ok: false, status: 400, error: "invalid_file" };
  const rel = file.startsWith("/") ? (file.startsWith(`${repo}/`) ? file.slice(repo.length + 1) : null) : file;
  if (rel === null || rel === "" || rel.endsWith("/") || rel.includes("//") || rel.split("/").some((seg) => seg === ".." || seg === ".")) {
    return { ok: false, status: 400, error: "invalid_file" };
  }
  return { ok: true, repo, rel };
}

/**
 * Match a well-formed request against the listing, and only then name it to git.
 *
 * `repo` has to be exactly one of the repositories just listed, and `file` exactly
 * one of its changed files. A value the listing does not hold is not found (404). So
 * the strings that reach git are the listing's own, never the caller's.
 */
export function resolvePatchTarget(
  repoParam: unknown,
  fileParam: unknown,
  listing: Map<string, Map<string, KnownFile>>,
  root: string = WORKSPACE_ROOT,
): PatchTarget {
  const shape = checkPatchParams(repoParam, fileParam, root);
  if (!shape.ok) return shape;
  const files = listing.get(shape.repo);
  if (!files) return { ok: false, status: 404, error: "repo_not_found" };
  const hit = files.get(shape.rel);
  if (!hit) return { ok: false, status: 404, error: "file_not_found" };
  return { ok: true, repo: shape.repo, file: shape.rel, untracked: hit.status === "?", ...(hit.orig ? { orig: hit.orig } : {}) };
}

/** Cut text to a byte budget on a character boundary. */
function clipBytes(text: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, cut: false };
  let out = buf.subarray(0, max).toString("utf8");
  while (out.endsWith("�")) out = out.slice(0, -1);
  return { text: out, cut: true };
}

// A credential's name, as a word that may sit inside a longer one (`DB_PASSWORD`, `--kube-token`, `api-key`).
// `author` is not one.
const CREDENTIAL_NAME_RE = /token|password|passwd|passphrase|secret|credentials?|api[-_]?key|access[-_]?key|private[-_]?key|auth(?!or)|bearer|cookie/i;
// The name is a whole run of name characters, hyphens and dots included (`api-key`, `config.password`), and a run is
// only ever started where it begins (the lookbehind): from every position inside it, a long `a.a.a.a...` would be
// rescanned to its end each time, which is quadratic.
// (A hyphen directly before it is a diff marker (`-TOKEN=x`) unless a name character is before that hyphen.)
const ASSIGNMENT_NAME_RE = /(?<![A-Za-z0-9_.])(?<![A-Za-z0-9_.]-)([A-Za-z0-9_][A-Za-z0-9_.-]*)["']?[^\S\n]*[:=][^\S\n]*/g;
const FLAG_NAME_RE = /[^\S\n](--?[A-Za-z0-9_-]+)/g;
// A quoted value, with its escapes: `"a\"b"`, `'it''s'`.
const ASSIGNED_VALUE_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'|[^\s"',;]+/y;
const FLAG_VALUE_RE = /(?:=|[^\S\n]+)("(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'|[^\s"']+)/y;
/** A bare value that is plainly code (a call, a member chain) and not a literal: `getPassword()`, `config.token`. */
const CODE_LIKE_RE = /\(|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
/** A YAML block scalar header: `|`, `>-`, `|+2`. What follows it, indented, is the value. */
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*[+-]?$/;
/** A private key in PEM form, wherever it sits and under whatever name; one that is cut off runs to the end. */
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?![\s\S]))/g;

/**
 * The lines of an indented block that follow `lineEnd` in patch text, as spans to mask: a diff line is a
 * one-character marker and then the file's line, and the block is every following line indented deeper than the
 * line that opened it (blank lines belong to it), up to the first line that is not.
 */
function blockLines(text: string, keyStart: number, lineEnd: number): Array<[number, number]> {
  const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
  const indent = /^[^\S\n]*/.exec(text.slice(lineStart + 1, lineEnd))?.[0].length ?? 0;
  const spans: Array<[number, number]> = [];
  let at = lineEnd + 1;
  while (at <= text.length && at > 0) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const line = text.slice(at + 1, end);
    const lead = /^[^\S\n]*/.exec(line)![0].length;
    const blank = lead === line.length;
    if (!blank && (lead <= indent || text.startsWith("@@", at) || text.startsWith("diff ", at))) break;
    if (!blank) spans.push([at + 1 + lead, end]);
    if (end >= text.length) break;
    at = end + 1;
  }
  return spans;
}

/**
 * Mask the credentials a changed file may hold, in patch text. `redactPublicJson` knows token shapes
 * (vendor prefixes, Bearer, URL userinfo) and nothing about NAMES, so `DB_PASSWORD=hunter2` or a
 * `"password": "x"` in a config file went through it untouched.
 *
 * A name that holds a credential word masks the literal that follows it: a quoted string always (escapes
 * included), a bare word unless it is plainly code, and a YAML block scalar with the block under it. A flag
 * whose name holds one masks its value. A PEM private key is masked wherever it is. The names are found by
 * patterns with no nested repetition and judged in code, so the cost is linear in the text however it is
 * shaped (a 64 KB line of letters, of dots, of one repeated word).
 */
export function maskCredentialText(text: string): string {
  const shapes = String(redactPublicJson(text) ?? "").replace(PEM_RE, "<redacted private key>");
  const spans: Array<[number, number]> = [];
  for (const m of shapes.matchAll(ASSIGNMENT_NAME_RE)) {
    if (!CREDENTIAL_NAME_RE.test(m[1])) continue;
    const from = m.index + m[0].length;
    ASSIGNED_VALUE_RE.lastIndex = from;
    const v = ASSIGNED_VALUE_RE.exec(shapes);
    if (!v) continue;
    const quoted = v[0][0] === '"' || v[0][0] === "'";
    if (!quoted && BLOCK_SCALAR_RE.test(v[0])) {
      let lineEnd = shapes.indexOf("\n", from);
      if (lineEnd < 0) lineEnd = shapes.length;
      spans.push([from, from + v[0].length], ...blockLines(shapes, m.index, lineEnd));
      continue;
    }
    if (!quoted && CODE_LIKE_RE.test(v[0])) continue;
    spans.push([from, from + v[0].length]);
  }
  for (const m of shapes.matchAll(FLAG_NAME_RE)) {
    if (!CREDENTIAL_NAME_RE.test(m[1])) continue;
    const nameEnd = m.index + m[0].length;
    FLAG_VALUE_RE.lastIndex = nameEnd;
    const v = FLAG_VALUE_RE.exec(shapes);
    if (!v) continue;
    const valueStart = nameEnd + v[0].length - v[1].length;
    spans.push([valueStart, valueStart + v[1].length]);
  }
  if (!spans.length) return shapes;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let last = 0;
  for (const [a, b] of spans) {
    if (a < last) continue;
    out += `${shapes.slice(last, a)}<redacted>`;
    last = b;
  }
  return out + shapes.slice(last);
}

/** The patch out of the patch script's output: decoded, secrets masked, cut at 64 KB. */
export function parsePatch(output: string): { patch: string; truncated: boolean } | null {
  const m = /^@@PATCH (\S*)$/m.exec(output);
  if (!m) return null;
  const raw = fromB64(m[1]).toString("utf8");
  const redacted = maskCredentialText(raw);
  const clipped = clipBytes(redacted, PATCH_MAX_BYTES);
  // The script reads a little more than the limit, so "more than the limit" is known.
  return { patch: clipped.text, truncated: clipped.cut || Buffer.byteLength(raw, "utf8") > PATCH_MAX_BYTES };
}
