// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The high-risk rule pack: a deterministic, versioned decision that a pull request
 * must not be merged without its acting user's own confirmation.
 *
 * What makes a change high risk is what it DOES, not which kind of file it touches
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
 * It runs in the API, on GitHub's own description of the change, and nothing the model
 * says can lower its answer. The reviewing model may only RAISE it: with `flags`
 * (`security_finding`, `review_skipped`) and with a content judgement, a short reason
 * that is shown to the acting user on the confirmation. It fails closed: a file list that
 * cannot be read in full, a patch GitHub did not send, a repository configuration that
 * does not parse and a rule that throws are all `high`. The rules are examples of what to
 * hold for a human, not a security scan.
 *
 * What the repository itself says comes from the BASE branch only (see
 * {@link parseClawyConfig}); a pull request that edits that file is high risk.
 */
import { addedLines, removedLines } from "./diff.js";
import { clipLine, contentFindings, isDoc, isSource, isTest, type Finding, type RiskCategory } from "./risk-signals.js";

export type { Finding, RiskCategory } from "./risk-signals.js";

export const RISK_RULE_PACK_VERSION = "2026-10-30.2";

/** What the reviewing model says about the change after reading it. It can only raise the verdict. */
export interface ReviewerJudgement {
  level: "low" | "high";
  /** One short sentence, shown to the acting user on the confirmation. */
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
  /** Extra globs (`*` within a segment, `**` across segments) that make a change high risk. */
  highRiskPaths: string[];
}

/**
 * Whether this file's change was not sent as a diff. GitHub omits `patch` for a binary, for a diff it considers too
 * large, and for a rename or a modified binary it counts as 0 lines, so the status and the counts cannot be used to
 * tell "nothing to read" from "nothing was shown": the absence is the only signal, and it is read the same way by the
 * risk rules and by the choice of review path.
 */
export function diffNotSent(f: Pick<RiskFile, "patch">): boolean {
  return f.patch === undefined;
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
  /** The reviewing model's own reading of the change; a `high` adds a reason, a `low` changes nothing. */
  judgement?: ReviewerJudgement | null;
}

export interface RiskResult {
  /** The verdict: `high` when there is any reason, from the rules or from the reviewer. */
  level: "low" | "high";
  reasons: string[];
  /** The kinds of change the reasons are about, in the order they first appear. */
  categories: RiskCategory[];
  /** What the rules alone say. The reviewer's judgement is never in it, and it never goes down because of it. */
  ruleLevel: "low" | "high";
  /** The reviewer's judgement is what made a change the rules call low into a high one. */
  raisedByReviewer: boolean;
  rulePack: string;
}

/**
 * The reviewer's judgement as it is kept: only a `high` with a reason counts, the reason is one clipped line without
 * control characters or markup that could dress it up on a card, and `mask` (the token and secret masking of the tool
 * answers) is applied to it. Anything else, a `low` included, is nothing: the model cannot lower a verdict.
 */
export function normaliseJudgement(raw: unknown, mask: (text: string) => string = (t) => t): ReviewerJudgement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { level, reason } = raw as { level?: unknown; reason?: unknown };
  if (level !== "high") return null;
  const text = mask(typeof reason === "string" ? reason : "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[`<>]/g, "'").replace(/\s+/g, " ").trim();
  const clipped = text.length > MAX_JUDGEMENT_REASON_CHARS ? `${text.slice(0, MAX_JUDGEMENT_REASON_CHARS - 1)}…` : text;
  return { level: "high", reason: clipped || "the reviewer judged this change high risk and gave no reason" };
}

/** Most files the reader fetches; a pull request with more is high risk by size alone. */
export const MAX_FILES_READ = 500;
const MAX_REASONS = 20;

const GOVERNANCE_PATHS: RegExp[] = [
  /^\.github\/(workflows|actions|scripts|codeql)\//i,
  /^\.github\/(CODEOWNERS|dependabot\.ya?ml|copilot-instructions\.md|clawy\.ya?ml)$/i,
  /^(CODEOWNERS|SECURITY\.md|REUSE\.toml|LICENSE[^/]*|COPYING[^/]*)$/i,
  /(^|\/)(AGENTS|CLAUDE)\.md$/i,
  /^\.(claude|agents|codex|cursor)\//i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)(azure-pipelines|Jenkinsfile|\.circleci\/config)/i,
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
 * The optional `.github/clawy.yml` of the base branch. Only two keys exist, and
 * only the plain shape is read:
 *
 *     confirm_merge: always        # or: risk
 *     high_risk_paths:
 *       - "docs/legal/**"
 *
 * Anything else that is not blank or a comment makes the file `invalid`, which is
 * high risk: a repository that wrote something this does not understand has not
 * been read.
 */
export function parseClawyConfig(text: string): RepoConfig | "invalid" {
  const config: RepoConfig = { confirmMerge: "risk", highRiskPaths: [] };
  let inPaths = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
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
    const item = /^\s+-\s+["']?([^"'\s][^"']*?)["']?\s*$/.exec(line);
    if (inPaths && item) {
      if (config.highRiskPaths.length >= 100) return "invalid";
      config.highRiskPaths.push((item[1] as string).trim());
      continue;
    }
    return "invalid";
  }
  return config;
}

function assess(input: RiskInput): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (category: RiskCategory, reason: string): void => {
    if (seen.has(reason)) return;
    seen.add(reason);
    findings.push({ category, reason });
  };

  // ---- the floor: nothing here reads what the change says, and all of it stays as a backstop.
  // Size and completeness first: nothing below can be trusted if the list is cut.
  if (!input.filesComplete || input.changedFiles > input.files.length) {
    add("integrity", `the change list is incomplete (${input.files.length} of ${input.changedFiles} files read)`);
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

  if (input.repoConfig === "invalid") add("provenance", "the repository's .github/clawy.yml could not be read");
  const extra = input.repoConfig && input.repoConfig !== "invalid" ? input.repoConfig : null;
  if (extra?.confirmMerge === "always") add("provenance", "the repository asks for confirmation on every merge");
  const extraGlobs = (extra?.highRiskPaths ?? []).map(globToRegExp);

  // ---- what the change does: architecture, interfaces, security-sensitive code (risk-signals.ts).
  const content = contentFindings(input.files);
  for (const f of content.findings) add(f.category, f.reason);
  // A file counts as changed for the path rules below when something of it really changed: a comment or a line that only
  // moved elsewhere is not a change to a Dockerfile, an authentication module or a deployment chart.
  const changed = (f: RiskFile): boolean => ["added", "removed", "renamed", "copied"].includes(f.status) || content.touched.has(f.path);

  let removedFiles = 0;
  const removedInTests = new Map<string, number>();
  for (const f of input.files) {
    const p = f.path;
    // A file moved out of a protected path is a change to that path, as much as one moved in or edited in place.
    for (const q of f.previousPath && f.previousPath !== p ? [p, f.previousPath] : [p]) {
      const where = q === p ? p : `${q} (moved to ${p})`;
      if (GOVERNANCE_PATHS.some((re) => re.test(q))) add("ci_release", `CI, workflow or governance file changed: ${where}`);
      if (AUTH_PATH.test(q) && isSource(q) && changed(f)) add("security", `authentication or security code changed: ${where}`);
      if (SECRET_PATHS.some((re) => re.test(q))) add("security", `secret-handling file changed: ${where}`);
      if (RELEASE_PATHS.some((re) => re.test(q)) && !isDoc(q) && changed(f)) add("ci_release", `release or deployment file changed: ${where}`);
      if (extraGlobs.some((re) => re.test(q))) add("provenance", `path the repository marks high risk: ${where}`);
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
    if (diffNotSent(f)) add("integrity", `diff not readable (binary, renamed without a diff, or too large): ${p}`);

    // Clipped: a pattern can cost no more than a bounded line, and a line too long to read is a reason of its own (risk-signals.ts).
    const added = addedLines(f.patch).map(clipLine);
    const removed = removedLines(f.patch).map(clipLine);
    if (/^Subproject commit /m.test((f.patch ?? "")) || added.some((l) => /^Subproject commit /.test(l))) add("integrity", `submodule pointer changed: ${p}`);
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

  for (const flag of input.flags ?? []) {
    if (flag === "security_finding") add("reviewer", "the review found a security issue (even if it was fixed)");
    else if (flag === "review_skipped") add("reviewer", "the review skipped a step");
    else add("reviewer", `the reviewer raised the flag ${flag.slice(0, 40)}`);
  }
  return findings;
}

/** Never throws: a rule that fails makes the answer `high`. */
export function assessRisk(input: RiskInput): RiskResult {
  let findings: Finding[];
  try {
    findings = assess(input);
  } catch {
    findings = [{ category: "integrity", reason: "the risk rules could not be evaluated" }];
  }
  const ruleLevel: "low" | "high" = findings.length > 0 ? "high" : "low";
  // The reviewer's reading can add to the verdict and never take from it. It goes first: it is the one reason written for
  // this change, and a card shows only the first few.
  const judged = input.judgement?.level === "high" ? input.judgement : null;
  if (judged) findings.unshift({ category: "reviewer", reason: `the reviewer's judgement: ${judged.reason}` });
  const shown = findings.slice(0, MAX_REASONS).map((f) => f.reason);
  if (findings.length > MAX_REASONS) shown.push(`and ${findings.length - MAX_REASONS} more`);
  const categories = [...new Set(findings.map((f) => f.category))];
  return {
    level: findings.length > 0 ? "high" : "low", reasons: shown, categories, ruleLevel,
    raisedByReviewer: judged !== null && ruleLevel === "low", rulePack: RISK_RULE_PACK_VERSION,
  };
}
