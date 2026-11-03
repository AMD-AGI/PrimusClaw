// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether an approval or a merge made with someone else's account is held for that person's own confirmation.
 *
 * The reviewing model decides it: its `risk_judgement` on `gh_review_submit` and `gh_pr_merge` (`high` holds, `low`
 * does not). The rules below do not decide it; they are EVIDENCE the model is shown with the pull request (and
 * {@link HOLD_GUIDANCE} says what to hold), because a rule that holds every large change or every outside author holds
 * nearly every approval, and a person asked about everything reads none of it. Only a few things hold whatever the
 * model says ({@link RiskResult.hardHolds}): what the repository itself asked for in its configuration (or a
 * configuration that cannot be read), a change to the files that decide who controls the repository (its workflows
 * and local actions, its CODEOWNERS, its review configuration), a file list that was cut or rules that failed (so
 * that change cannot be ruled out), and a judgement that is missing or malformed (fail closed). The model's flags
 * (`security_finding`, `review_skipped`) hold as well: they are its own judgement.
 *
 * What the rules flag is what a change DOES, not which kind of file it touches
 * (see risk-signals.ts): an architecture change (a package or deployable unit added or
 * removed, a directory moved, the layering or the dependency graph changed), an interface
 * change (an exported signature, an HTTP route, a schema, a command-line flag, a
 * configuration or environment contract, a database schema, a wire or event format),
 * code that decides who may do what (authentication, cryptography, permissions,
 * secrets), CI and release workflows, dependency manifests, and size and breadth. A pure
 * refactor, a move of code, a reformat, documentation and tests stay low.
 *
 * Under that sits a floor that does not read content and is kept as a backstop: a file
 * that came without its diff (a binary, a diff GitHub found too large, a rename), a lock
 * file, a submodule pointer, a file mode change, a file list that was cut, a fork, a
 * non-member, a base branch that is not the default.
 *
 * The rules run in the API, on GitHub's own description of the change, and the hard holds among them cannot be lowered
 * by anything the model says. They are examples of what a person may want to look at, not a security scan.
 *
 * What the repository itself says comes from the BASE branch only (see
 * {@link parseRepoConfig}); a pull request that edits that file is held.
 */
import { LEGACY_REPO_CONFIG_STEM } from "./legacy-names.js";
import { isReviewInstructionPath } from "./repo-skill.js";
import { MAX_READ_CHARS, MAX_READ_LINES, contentFindings, isDoc, isSource, isTest, rawHead, readChange, type Finding, type RiskCategory } from "./risk-signals.js";

export type { Finding, RiskCategory } from "./risk-signals.js";

export const RISK_RULE_PACK_VERSION = "2026-11-03.1";

/** The repository's own configuration file, read from the base branch ({@link parseRepoConfig}). */
export const REPO_CONFIG_PATH = ".github/claw-review.yml";

/** What the reviewing model says about the change after reading it: `high` holds an approval or a merge for the acting user, `low` lets it go. */
export interface ReviewerJudgement {
  level: "low" | "high";
  /** One short sentence; a `high` one is what the acting user reads first on the confirmation. */
  reason: string;
}

/** Longest reason kept: it is printed on a card. */
export const MAX_JUDGEMENT_REASON_CHARS = 200;

export interface RiskFile {
  path: string;
  /** Where a renamed or copied file came from; the path rules read it as well as `path`. */
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** GitHub omits it for a binary file and for a diff it considers too large. */
  patch?: string;
}

export interface RepoConfig {
  /** `always` holds every merge for the acting user, whatever the rules say. */
  confirmMerge: "always" | "risk";
  /** Extra globs (`*` within a segment, `**` across segments) that hold a change whatever the reviewer says. */
  highRiskPaths: string[];
}

/**
 * Whether this file's change was not sent as a diff. GitHub omits `patch` for a binary, for a diff it considers too
 * large, and for a rename or a modified binary it counts as 0 lines, so the status and the counts cannot be used to
 * tell "nothing to read" from "nothing was shown": the absence is the only signal, and it is read the same way by the
 * risk rules and by the choice of review path.
 */
export function diffNotSent(f: Pick<RiskFile, "patch">): boolean {
  return f.patch === undefined || isLfsPointerPatch(f.patch);
}

/**
 * A file tracked by Git LFS is a small text pointer in the repository (`version https://git-lfs.github.com/spec/v1`, `oid sha256:<hash>`,
 * `size <bytes>`), and that pointer is what GitHub sends as the patch: a swapped executable or a set of model weights shows as two changed
 * lines of hex, which no rule can read as the change it is. It is the same as a binary whose diff was not sent: what changed was not shown.
 */
const LFS_POINTER_LINE = /^[ +-](?:version https:\/\/(?:git-lfs|hawser)\.github\.com\/spec\/v\d+|oid sha256:[0-9a-f]{64})\r?$/m;
export function isLfsPointerPatch(patch: string): boolean {
  return LFS_POINTER_LINE.test(rawHead(patch));
}

export interface RiskInput {
  files: RiskFile[];
  /** What the pull request says it changes; larger than `files` when the list was cut. */
  changedFiles: number;
  filesComplete: boolean;
  additions: number;
  deletions: number;
  fork: boolean;
  authorAssociation: string;
  baseRef: string;
  defaultBranch: string;
  /** From the base branch. Null when the repository has none; `invalid` when it has one that does not parse. */
  repoConfig: RepoConfig | null | "invalid";
  /** Escalations only: `security_finding`, `review_skipped`. */
  flags?: string[];
  /** The reviewing model's own reading of the change, which decides the hold; none or a malformed one holds. */
  judgement?: ReviewerJudgement | null;
}

export interface RiskResult {
  /** `high`: an approval or a merge is held for the acting user. */
  level: "low" | "high";
  /** Why it is held, in plain words, the reviewer's own reason first; empty when it is not. This is what the confirmation shows. */
  reasons: string[];
  /** What the rules saw in the change. Shown to the reviewer as evidence; none of it holds by itself. */
  evidence: string[];
  /** The rules' findings that hold whatever the reviewer says (also in `reasons`). */
  hardHolds: string[];
  /**
   * Those of `hardHolds` that hold whatever the acting user's review mode says as well: the repository's own requirement, and a change to
   * the instructions the reviewing model reads (repo-skill.ts).
   */
  repoHolds: string[];
  /** The kinds of change the evidence and the reasons are about, in the order they first appear. */
  categories: RiskCategory[];
  /** `high` when the rules saw anything at all: evidence for the reviewer, not the verdict. */
  ruleLevel: "low" | "high";
  /** The reviewer's judgement as it counted: `missing` when there was none or it did not parse, which holds. */
  judgement: "low" | "high" | "missing";
  rulePack: string;
}

/**
 * What the reviewing model is told about the hold, with the evidence: the model decides, and these are the cases to hold for. Kept here so the
 * tool answer, the tool descriptions and the review skill say the same thing.
 */
export const HOLD_GUIDANCE = "Your risk_judgement decides whether an approval or a merge waits for the person whose account is used: "
  + "high holds it for their confirmation, low lets it go through the other gates. Hold (high) only for what a person should look at: "
  + "security-sensitive code (authentication, authorization, permissions, cryptography, sandboxing), credentials or secrets, CI, workflow, release "
  + "or deployment changes, permission or access changes, destructive or irreversible data migrations, a change of an interface or behaviour others "
  + "rely on that the pull request text does not explain, or anything you are unsure of. Otherwise judge low: size, an outside author, a fork or a "
  + "base branch are evidence to read, not reasons by themselves, and the person who asked is very often the author. hard_holds hold whatever you say. "
  + "A missing judgement holds. When the acting user's review_mode is fully_auto, only repo_holds hold, but judge all the same.";

/**
 * The reviewer's judgement as it is kept: a `low` with a reason or a `high`, the reason one clipped line without control characters or
 * markup that could dress it up on a card, with `mask` (the token and secret masking of the tool answers) applied to it. Anything else
 * is no judgement, which holds.
 */
export function normaliseJudgement(raw: unknown, mask: (text: string) => string = (t) => t): ReviewerJudgement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { level, reason } = raw as { level?: unknown; reason?: unknown };
  if (level !== "high" && level !== "low") return null;
  const text = mask(typeof reason === "string" ? reason : "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[`<>]/g, "'").replace(/\s+/g, " ").trim();
  const clipped = text.length > MAX_JUDGEMENT_REASON_CHARS ? `${text.slice(0, MAX_JUDGEMENT_REASON_CHARS - 1)}…` : text;
  // A low with nothing said for it is no judgement: the hold is lifted only by a reviewer who says why.
  if (level === "low") return clipped ? { level, reason: clipped } : null;
  return { level, reason: clipped || "the reviewer judged this change high risk and gave no reason" };
}

/** Most files the reader fetches; a pull request with more has a cut file list, which holds. */
export const MAX_FILES_READ = 500;
const MAX_REASONS = 20;

const GOVERNANCE_PATHS: RegExp[] = [
  /^\.github\/(workflows|actions|scripts|codeql)\//i,
  new RegExp(`^\\.github\\/(CODEOWNERS|dependabot\\.ya?ml|copilot-instructions\\.md|claw-review\\.ya?ml|${LEGACY_REPO_CONFIG_STEM}\\.ya?ml)$`, "i"),
  /^(CODEOWNERS|SECURITY\.md|REUSE\.toml|LICENSE[^/]*|COPYING[^/]*)$/i,
  /(^|\/)(AGENTS|CLAUDE)\.md$/i,
  /^\.(claude|agents|codex|cursor)\//i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)(azure-pipelines|Jenkinsfile|\.circleci\/config)/i,
];
/**
 * The files that decide who controls the repository: its workflows and the local actions they run (which act with the workflow's token),
 * who must review what (CODEOWNERS, in each place GitHub reads it), and this feature's own configuration (which can switch the hold off).
 * A change to one holds whatever the reviewer says.
 */
const CONTROL_PATHS: RegExp[] = [
  /^\.github\/(workflows|actions|scripts)\//i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)(azure-pipelines|Jenkinsfile|\.circleci\/config)/i,
  /^(\.github\/|docs\/)?CODEOWNERS$/i,
  new RegExp(`^\\.github\\/(claw-review|${LEGACY_REPO_CONFIG_STEM})\\.ya?ml$`, "i"),
];
const AUTH_PATH = /(^|[/._-])(auth|authn|authz|rbac|iam|oauth|oidc|jwt|session|sessions|crypto|tls|sandbox|permission|permissions)([/._-]|$)/i;
const SECRET_PATHS: RegExp[] = [
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?([./_-]|$)/i,
  /(^|\/)(id_rsa|id_ed25519|credentials)(\.|$)/i,
];
const RELEASE_PATHS: RegExp[] = [
  /(^|\/)Dockerfile[^/]*$/i,
  /^(deploy|charts?|helm|k8s|kubernetes|manifests)\//i,
  /(^|\/)(Chart|values)[^/]*\.ya?ml$/i,
  /\.tf$/i,
  /(^|\/)\.goreleaser[^/]*$/i,
  /(^|\/)(install|setup|release|publish|deploy)[^/]*\.(sh|ps1)$/i,
  /(^|\/)Makefile$/i,
];
const MANIFESTS = /(^|\/)(package\.json|go\.mod|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|setup\.py|setup\.cfg|composer\.json|Pipfile|Package\.swift|mix\.exs|pubspec\.ya?ml|Podfile)$/i;
const LOCKS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|deno\.lock|go\.sum|poetry\.lock|pdm\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|packages\.lock\.json|gradle\.lockfile|Podfile\.lock|Package\.resolved|mix\.lock|pubspec\.lock|flake\.lock)$/i;

const INSECURE_LINES: Array<[RegExp, string]> = [
  [/verify\s*=\s*False/, "TLS verification switched off (verify=False)"],
  [/InsecureSkipVerify\s*:\s*true/, "TLS verification switched off (InsecureSkipVerify)"],
  [/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, "TLS verification switched off (Node)"],
  [/ssl_?verify\s*[=:]\s*(false|0)/i, "TLS verification switched off"],
  [/\ballow_all\b|\bpermit_all\b/i, "a rule that allows everything"],
  [/(disable|skip|bypass)[_-]?(auth|authn|authz|authentication|authorization)\b/i, "authentication or authorization switched off"],
  [/--no-verify\b|--insecure\b|--no-check-certificate\b/, "a verification-skipping flag"],
  [/\bchmod\s+(-R\s+)?(0?777|a\+rwx)\b/, "a world-writable mode"],
];
const SECRET_LINES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key shape"],
  [/\bak-[A-Za-z0-9]{24,}/, "an API key shape"],
  [/^\s*kind:\s*Secret\b|\bsecretKeyRef\b/, "a Kubernetes Secret"],
];
const MANIFEST_RELEASE_FIELDS = /^\s*"?(version|scripts|publishConfig|bin|postinstall|preinstall|prepare|prepublishOnly|private|main|exports)"?\s*[:=]/i;
/** Lines of a manifest that declare a dependency or its version, in the shapes the common package managers use. */
const DEPENDENCY_LINES: RegExp[] = [
  /^\s*["']?[@\w./-]+["']?\s*[:=]\s*["'][~^<>=!v]*\d/,
  /^\s*["']?[@\w./-]+["']?\s*[:=]\s*["'](\*|latest|workspace:|npm:|link:)/,
  /^\s*[A-Za-z0-9][\w.-]*(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|<|>)\s*\d/,
  // `host.tld/path v1.2.3`. The dotted host is written so that its pieces cannot overlap (a dot only ever separates them): the
  // obvious `[\w.-]+\.[\w.-]+` backtracks quadratically on a long line of dots and letters.
  /^\s*[\w-]+(?:\.[\w-]+)+\/[\w./-]+\s+v\d/,
  /^\s*(require|replace)\b/,
  /^\s*[\w-]+\s*=\s*\{[^}]*(version|git|path)\s*=/,
];
const SOURCE_LINE = /(git\+|git:\/\/|github\.com[:/]|https?:\/\/|file:|\.\.\/)/i;

/** `*` matches inside one path segment, `**` across segments. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; } else out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The line without the comment at its end: from the first `#` that follows whitespace. Plain string code, because the pattern for it
 * (a run of whitespace, a `#`, then the rest of the line) restarts at every character of a long run of whitespace that no `#` ends,
 * and the file is read whole, in the API's own process, with no limit on a line.
 */
function withoutTrailingComment(line: string): string {
  // A comment runs to the end of the line, and a line break inside what is called a line (a lone carriage return, U+2028, U+2029) ends the
  // reach of the pattern this replaces: a `#` before the last of them is not the start of a comment, and the file stays unreadable.
  const lastBreak = Math.max(line.lastIndexOf("\r"), line.lastIndexOf("\u2028"), line.lastIndexOf("\u2029"));
  for (let i = Math.max(1, lastBreak + 1); i < line.length; i++) {
    if (line.charCodeAt(i) === 35 && /\s/.test(line[i - 1] as string)) return line.slice(0, i);
  }
  return line;
}

/**
 * The value of a list item (`  - "docs/legal/**"`): what stands after the dash, without one quote on either side. Plain string code for
 * the same reason as above (a lazy run and the whitespace after it both match a long run of spaces). `null` when the line is not an item.
 * The value stops at the first quote, and what follows that quote must be nothing but whitespace, as the quoted forms always were.
 */
function listItemValue(line: string): string | null {
  const dash = /^\s+-\s+/.exec(line);
  if (!dash) return null;
  let rest = line.slice(dash[0].length);
  if (rest[0] === '"' || rest[0] === "'") rest = rest.slice(1);
  if (rest === "" || /^[\s"']/.test(rest)) return null;
  const quote = rest.search(/["']/);
  if (quote < 0) return rest.trimEnd();
  return rest.slice(quote + 1).trim() === "" ? rest.slice(0, quote) : null;
}

/**
 * The optional {@link REPO_CONFIG_PATH} of the base branch (an earlier release read another name, see legacy-names.ts, which
 * is still read when this one is absent). Only two keys exist, and only the plain shape is read:
 *
 *     confirm_merge: always        # or: risk
 *     high_risk_paths:
 *       - "docs/legal/**"
 *
 * Anything else that is not blank or a comment makes the file `invalid`, which is
 * held: a repository that wrote something this does not understand has not
 * been read.
 */
export function parseRepoConfig(text: string): RepoConfig | "invalid" {
  const config: RepoConfig = { confirmMerge: "risk", highRiskPaths: [] };
  let inPaths = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutTrailingComment(raw).trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const key = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (key) {
      const [, name, value] = key as unknown as [string, string, string];
      inPaths = false;
      if (name === "confirm_merge") {
        if (value !== "always" && value !== "risk") return "invalid";
        config.confirmMerge = value;
      } else if (name === "high_risk_paths" && value === "") {
        inPaths = true;
      } else {
        return "invalid";
      }
      continue;
    }
    const item = inPaths ? listItemValue(line) : null;
    if (item !== null) {
      if (config.highRiskPaths.length >= 100) return "invalid";
      config.highRiskPaths.push(item.trim());
      continue;
    }
    return "invalid";
  }
  return config;
}

/**
 * The rules' findings, which of their reasons hold whatever the reviewer says (`hard`), and which of those are the repository's own
 * requirement (`repo`), which holds whatever the acting user's review mode says as well.
 */
function assess(input: RiskInput): { findings: Finding[]; hard: Set<string>; repo: Set<string> } {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const hard = new Set<string>();
  const repo = new Set<string>();
  const add = (category: RiskCategory, reason: string, holds: false | "hard" | "repo" = false): void => {
    if (holds) hard.add(reason);
    if (holds === "repo") repo.add(reason);
    if (seen.has(reason)) return;
    seen.add(reason);
    findings.push({ category, reason });
  };

  // ---- the floor: nothing here reads what the change says, and all of it stays as a backstop.
  // Size and completeness first: nothing below can be trusted if the list is cut, and a cut list cannot show that no file that controls the
  // repository changed, so it holds.
  if (!input.filesComplete || input.changedFiles > input.files.length) {
    add("integrity", `the change list is incomplete (${input.files.length} of ${input.changedFiles} files read)`, "hard");
  }
  if (input.changedFiles > 3000) add("integrity", "more than 3000 files changed: GitHub's file list limit");
  if (input.changedFiles > 40) add("size_breadth", `large change: ${input.changedFiles} files`);
  if (input.additions + input.deletions > 1000) add("size_breadth", `large change: ${input.additions + input.deletions} lines`);
  if (input.deletions > 300) add("size_breadth", `${input.deletions} lines deleted`);
  if (input.deletions >= 100 && input.deletions > (input.additions + input.deletions) / 2) add("size_breadth", "mostly deletions");

  if (input.fork) add("provenance", "the pull request comes from a fork");
  if (!["MEMBER", "OWNER", "COLLABORATOR"].includes(input.authorAssociation)) {
    add("provenance", `the author is not a member of the organisation (${input.authorAssociation || "unknown"})`);
  }
  if (input.baseRef !== input.defaultBranch) add("provenance", `the base branch is ${input.baseRef}, not the default branch ${input.defaultBranch}`);

  // What the repository asked for holds whatever the reviewer says, and a configuration that cannot be read may have asked for it.
  if (input.repoConfig === "invalid") add("provenance", `the repository's ${REPO_CONFIG_PATH} could not be read`, "repo");
  const extra = input.repoConfig && input.repoConfig !== "invalid" ? input.repoConfig : null;
  if (extra?.confirmMerge === "always") add("provenance", "the repository asks for confirmation on every merge", "repo");
  const extraGlobs = (extra?.highRiskPaths ?? []).map(globToRegExp);
  // A path the repository marks may be among the files that were not read.
  if (extraGlobs.length > 0 && (!input.filesComplete || input.changedFiles > input.files.length)) {
    add("provenance", "the repository marks paths high risk and not every changed file was read", "repo");
  }

  // ---- what the change does: architecture, interfaces, security-sensitive code (risk-signals.ts).
  const read = readChange(input.files);
  const content = contentFindings(input.files, read);
  for (const f of content.findings) add(f.category, f.reason);
  if (read.truncated) add("integrity", `more changed text than is read line by line (over ${MAX_READ_LINES} lines or ${MAX_READ_CHARS} characters): the rest was not read`);

  let removedFiles = 0;
  const removedInTests = new Map<string, number>();
  for (const f of input.files) {
    const p = f.path;
    // A file moved out of a protected path is a change to that path, as much as one moved in or edited in place.
    for (const q of f.previousPath && f.previousPath !== p ? [p, f.previousPath] : [p]) {
      const where = q === p ? p : `${q} (moved to ${p})`;
      const controls = CONTROL_PATHS.some((re) => re.test(q));
      if (controls || GOVERNANCE_PATHS.some((re) => re.test(q))) add("ci_release", `CI, workflow or governance file changed: ${where}`, controls && "hard");
      // What the reviewing model is told decides this very hold: a change to it holds under every review mode, as the repository's own requirement does.
      if (isReviewInstructionPath(q)) add("ci_release", `the instructions the reviewing model reads changed: ${where}`, "repo");
      // The path rules below read no content and are a floor: an edit that looks like a comment, or a line that moved, does not lower them
      // (what a comment is depends on the language, and a line shaped like one can be code). The content half above can only add to them.
      if (AUTH_PATH.test(q) && isSource(q)) add("security", `authentication or security code changed: ${where}`);
      if (SECRET_PATHS.some((re) => re.test(q))) add("security", `secret-handling file changed: ${where}`);
      if (RELEASE_PATHS.some((re) => re.test(q)) && !isDoc(q)) add("ci_release", `release or deployment file changed: ${where}`);
      if (extraGlobs.some((re) => re.test(q))) add("provenance", `path the repository marks high risk: ${where}`, "repo");
    }
    // A lock file decides which tarball or checksum an install fetches, and nothing here reads its lines. A manifest
    // edited somewhere else in the same change says nothing about it, so a lock file is held whatever else changed:
    // a real dependency change is held by the manifest rule below in any case.
    if (LOCKS.test(p) || (f.previousPath !== undefined && LOCKS.test(f.previousPath))) add("integrity", `lock file changed (it decides what an install downloads): ${p}`);
    if (f.status === "removed") {
      removedFiles += 1;
      const dir = p.replace(/\/[^/]*$/, "");
      if (isTest(p)) removedInTests.set(dir, (removedInTests.get(dir) ?? 0) + 1);
    }
    if (f.status === "changed") add("integrity", `file mode or type changed: ${p}`);
    // Whatever the status and the line counts say, a change that came without its diff was not read (see diffNotSent).
    if (f.patch === undefined) add("integrity", `diff not readable (binary, renamed without a diff, or too large): ${p}`);
    else if (diffNotSent(f)) add("integrity", `Git LFS file changed (the pointer is shown, not the file it stands for): ${p}`);

    // Read once, clipped and within a budget: a pattern can cost no more than a bounded line, a line too long to read is a reason of its
    // own, and so is a change with more text than is read at all (risk-signals.ts).
    const { added, removed } = read.lines.get(f) ?? { added: [], removed: [] };
    if (/^Subproject commit /m.test(rawHead(f.patch)) || added.some((l) => /^Subproject commit /.test(l))) add("integrity", `submodule pointer changed: ${p}`);
    for (const line of added) {
      // A sentence in the documentation that names `--insecure`, or a test that switches verification off on purpose, is not
      // product code switching it off. A secret on any line, wherever it is, still is.
      if (isSource(p)) for (const [re, what] of INSECURE_LINES) if (re.test(line)) add("security", `added line with ${what}: ${p}`);
      for (const [re, what] of SECRET_LINES) if (re.test(line)) add("security", `added line with ${what}: ${p}`);
    }
    if (MANIFESTS.test(p)) {
      if (/(^|\/)package\.json$/i.test(p) && [...added, ...removed].some((l) => MANIFEST_RELEASE_FIELDS.test(l))) {
        add("dependency", `package metadata (version, scripts, publish fields) changed: ${p}`);
      }
      if (added.some((l) => DEPENDENCY_LINES.some((re) => re.test(l)))) add("dependency", `dependency added or changed: ${p}`);
      if (added.some((l) => SOURCE_LINE.test(l))) add("dependency", `dependency or setting from a git or URL source: ${p}`);
    }
  }
  if (removedFiles > 5) add("size_breadth", `${removedFiles} files deleted`);
  for (const [dir, n] of removedInTests) if (n >= 3) add("size_breadth", `${n} test files deleted under ${dir}`);

  return { findings, hard, repo };
}

const clipReasons = (reasons: string[]): string[] =>
  reasons.length > MAX_REASONS ? [...reasons.slice(0, MAX_REASONS), `and ${reasons.length - MAX_REASONS} more`] : reasons;

/** Never throws: a rule that fails holds. */
export function assessRisk(input: RiskInput): RiskResult {
  let findings: Finding[];
  let hard: Set<string>;
  let repo: Set<string>;
  try {
    ({ findings, hard, repo } = assess(input));
  } catch {
    // The repository's own requirement could not be read either.
    const failed = "the risk rules could not be evaluated";
    findings = [{ category: "integrity", reason: failed }];
    hard = new Set([failed]);
    repo = hard;
  }
  // The reviewer's reading goes first: it is the one reason written for this change, and a card shows only the first few.
  const judgement = input.judgement ?? null;
  const said: Finding[] = [];
  if (judgement?.level === "high") said.push({ category: "reviewer", reason: `the reviewer's judgement: ${judgement.reason}` });
  for (const flag of new Set(input.flags ?? [])) {
    if (flag === "security_finding") said.push({ category: "reviewer", reason: "the review found a security issue (even if it was fixed)" });
    else if (flag === "review_skipped") said.push({ category: "reviewer", reason: "the review skipped a step" });
    else said.push({ category: "reviewer", reason: `the reviewer raised the flag ${flag.slice(0, 40)}` });
  }
  const hardHolds = findings.filter((f) => hard.has(f.reason)).map((f) => f.reason);
  const reasons = [
    ...said.map((f) => f.reason),
    // Not a kind of change, so it has no category.
    ...(judgement ? [] : ["the reviewer gave no risk judgement, so it is held for the person"]),
    ...hardHolds,
  ];
  return {
    level: reasons.length > 0 ? "high" : "low",
    reasons: clipReasons(reasons),
    evidence: clipReasons(findings.map((f) => f.reason)),
    hardHolds: clipReasons(hardHolds),
    repoHolds: clipReasons(hardHolds.filter((r) => repo.has(r))),
    categories: [...new Set([...said, ...findings].map((f) => f.category))],
    ruleLevel: findings.length > 0 ? "high" : "low",
    judgement: judgement ? judgement.level : "missing",
    rulePack: RISK_RULE_PACK_VERSION,
  };
}
