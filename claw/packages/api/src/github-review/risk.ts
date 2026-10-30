// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The high-risk rule pack: a deterministic, versioned decision that a pull request
 * must not be merged without its acting user's own confirmation.
 *
 * It runs in the API, on GitHub's own description of the change, and nothing the
 * model says can lower its answer; the model may only add to it (`flags`). It fails
 * closed: a file list that cannot be read in full, a patch GitHub did not send, a
 * repository configuration that does not parse and a rule that throws are all
 * `high`. The rules are examples of what to hold for a human, not a security scan.
 *
 * What the repository itself says comes from the BASE branch only (see
 * {@link parseClawyConfig}); a pull request that edits that file is high risk.
 */
import { addedLines, removedLines } from "./diff.js";

export const RISK_RULE_PACK_VERSION = "2026-10-30.1";

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
}

export interface RiskResult {
  level: "low" | "high";
  reasons: string[];
  rulePack: string;
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
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//i;

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
  /^\s*[\w.-]+\.[\w.-]+\/[\w./-]+\s+v\d/,
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

function assess(input: RiskInput): string[] {
  const reasons: string[] = [];
  const add = (r: string): void => { if (!reasons.includes(r)) reasons.push(r); };

  // Size and completeness first: nothing below can be trusted if the list is cut.
  if (!input.filesComplete || input.changedFiles > input.files.length) {
    add(`the change list is incomplete (${input.files.length} of ${input.changedFiles} files read)`);
  }
  if (input.changedFiles > 3000) add("more than 3000 files changed: GitHub's file list limit");
  if (input.changedFiles > 40) add(`large change: ${input.changedFiles} files`);
  if (input.additions + input.deletions > 1000) add(`large change: ${input.additions + input.deletions} lines`);
  if (input.deletions > 300) add(`${input.deletions} lines deleted`);
  if (input.deletions >= 100 && input.deletions > (input.additions + input.deletions) / 2) add("mostly deletions");

  if (input.fork) add("the pull request comes from a fork");
  if (!["MEMBER", "OWNER", "COLLABORATOR"].includes(input.authorAssociation)) {
    add(`the author is not a member of the organisation (${input.authorAssociation || "unknown"})`);
  }
  if (input.baseRef !== input.defaultBranch) add(`the base branch is ${input.baseRef}, not the default branch ${input.defaultBranch}`);

  if (input.repoConfig === "invalid") add("the repository's .github/clawy.yml could not be read");
  const extra = input.repoConfig && input.repoConfig !== "invalid" ? input.repoConfig : null;
  if (extra?.confirmMerge === "always") add("the repository asks for confirmation on every merge");
  const extraGlobs = (extra?.highRiskPaths ?? []).map(globToRegExp);

  let removedFiles = 0;
  const removedInTests = new Map<string, number>();
  for (const f of input.files) {
    const p = f.path;
    // A file moved out of a protected path is a change to that path, as much as one moved in or edited in place.
    for (const q of f.previousPath && f.previousPath !== p ? [p, f.previousPath] : [p]) {
      const where = q === p ? p : `${q} (moved to ${p})`;
      if (GOVERNANCE_PATHS.some((re) => re.test(q))) add(`CI, workflow or governance file changed: ${where}`);
      if (AUTH_PATH.test(q)) add(`authentication or security code changed: ${where}`);
      if (SECRET_PATHS.some((re) => re.test(q))) add(`secret-handling file changed: ${where}`);
      if (RELEASE_PATHS.some((re) => re.test(q))) add(`release or deployment file changed: ${where}`);
      if (extraGlobs.some((re) => re.test(q))) add(`path the repository marks high risk: ${where}`);
    }
    // A lock file decides which tarball or checksum an install fetches, and nothing here reads its lines. A manifest
    // edited somewhere else in the same change says nothing about it, so a lock file is held whatever else changed:
    // a real dependency change is held by the manifest rule below in any case.
    if (LOCKS.test(p) || (f.previousPath !== undefined && LOCKS.test(f.previousPath))) add(`lock file changed (it decides what an install downloads): ${p}`);
    if (f.status === "removed") {
      removedFiles += 1;
      const dir = p.replace(/\/[^/]*$/, "");
      if (TEST_DIR.test(p)) removedInTests.set(dir, (removedInTests.get(dir) ?? 0) + 1);
    }
    if (f.status === "changed") add(`file mode or type changed: ${p}`);
    // Whatever the status and the line counts say, a change that came without its diff was not read (see diffNotSent).
    if (diffNotSent(f)) add(`diff not readable (binary, renamed without a diff, or too large): ${p}`);

    const added = addedLines(f.patch);
    const removed = removedLines(f.patch);
    if (/^Subproject commit /m.test((f.patch ?? "")) || added.some((l) => /^Subproject commit /.test(l))) add(`submodule pointer changed: ${p}`);
    for (const line of added) {
      for (const [re, what] of INSECURE_LINES) if (re.test(line)) add(`added line with ${what}: ${p}`);
      for (const [re, what] of SECRET_LINES) if (re.test(line)) add(`added line with ${what}: ${p}`);
    }
    if (MANIFESTS.test(p)) {
      if (/(^|\/)package\.json$/i.test(p) && [...added, ...removed].some((l) => MANIFEST_RELEASE_FIELDS.test(l))) {
        add(`package metadata (version, scripts, publish fields) changed: ${p}`);
      }
      if (added.some((l) => DEPENDENCY_LINES.some((re) => re.test(l)))) add(`dependency added or changed: ${p}`);
      if (added.some((l) => SOURCE_LINE.test(l))) add(`dependency or setting from a git or URL source: ${p}`);
    }
  }
  if (removedFiles > 5) add(`${removedFiles} files deleted`);
  for (const [dir, n] of removedInTests) if (n >= 3) add(`${n} test files deleted under ${dir}`);

  for (const flag of input.flags ?? []) {
    if (flag === "security_finding") add("the review found a security issue (even if it was fixed)");
    else if (flag === "review_skipped") add("the review skipped a step");
    else add(`the reviewer raised the flag ${flag.slice(0, 40)}`);
  }
  return reasons;
}

/** Never throws: a rule that fails makes the answer `high`. */
export function assessRisk(input: RiskInput): RiskResult {
  let reasons: string[];
  try {
    reasons = assess(input);
  } catch {
    reasons = ["the risk rules could not be evaluated"];
  }
  const shown = reasons.slice(0, MAX_REASONS);
  if (reasons.length > MAX_REASONS) shown.push(`and ${reasons.length - MAX_REASONS} more`);
  return { level: reasons.length > 0 ? "high" : "low", reasons: shown, rulePack: RISK_RULE_PACK_VERSION };
}
