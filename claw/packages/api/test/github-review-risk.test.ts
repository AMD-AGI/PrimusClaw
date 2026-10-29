// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The high-risk rule pack. Table-driven: each row is a change and whether it must
 * hold a merge for the acting user. Low-risk rows matter as much as high ones: a
 * rule that held everything would be a confirmation nobody reads.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assessRisk, globToRegExp, parseClawyConfig, RISK_RULE_PACK_VERSION, type RiskFile, type RiskInput } from "../src/github-review/risk.js";

const file = (path: string, patch = "@@ -1,1 +1,2 @@\n a\n+b", over: Partial<RiskFile> = {}): RiskFile => ({ path, status: "modified", additions: 1, deletions: 0, patch, ...over });
const input = (files: RiskFile[], over: Partial<RiskInput> = {}): RiskInput => ({
  files, changedFiles: files.length, filesComplete: true,
  additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
  fork: false, authorAssociation: "MEMBER", baseRef: "main", defaultBranch: "main", repoConfig: null, ...over,
});
const patchWith = (...added: string[]): string => `@@ -1,1 +1,${added.length + 1} @@\n a\n${added.map((l) => `+${l}`).join("\n")}`;

test("an ordinary change is low risk, and the verdict names the rule pack", () => {
  const r = assessRisk(input([file("src/render.ts"), file("test/render.test.ts")]));
  assert.deepEqual(r, { level: "low", reasons: [], rulePack: RISK_RULE_PACK_VERSION });
});

const HIGH: Array<[string, RiskInput, RegExp]> = [
  ["a workflow", input([file(".github/workflows/ci.yml")]), /workflow/],
  ["an action", input([file(".github/actions/setup/action.yml")]), /workflow/],
  ["CODEOWNERS", input([file(".github/CODEOWNERS")]), /governance/],
  ["dependabot", input([file(".github/dependabot.yml")]), /governance/],
  ["the repository's own agent instructions", input([file("AGENTS.md")]), /governance/],
  ["a nested AGENTS.md", input([file("tools/x/AGENTS.md")]), /governance/],
  ["a skill under .claude", input([file(".claude/skills/review-pr/SKILL.md")]), /governance/],
  ["the repository's clawy config", input([file(".github/clawy.yml")]), /governance/],
  ["the licence", input([file("LICENSE")]), /governance/],
  ["SECURITY.md", input([file("SECURITY.md")]), /governance/],
  ["auth code", input([file("src/auth/login.ts")]), /authentication/],
  ["a jwt file", input([file("lib/jwt_verify.go")]), /authentication/],
  ["a sandbox file", input([file("pkg/sandbox/run.go")]), /authentication/],
  ["a permission file", input([file("api/permissions.py")]), /authentication/],
  ["a pem file", input([file("deploy/tls.pem")]), /secret-handling/],
  ["an env file", input([file(".env.production")]), /secret-handling/],
  ["a secrets directory", input([file("config/secrets/app.yaml")]), /secret-handling/],
  ["TLS verification switched off in Python", input([file("src/x.py", patchWith("requests.get(u, verify=False)"))]), /TLS verification/],
  ["TLS verification switched off in Go", input([file("src/x.go", patchWith("tls.Config{InsecureSkipVerify: true}"))]), /TLS verification/],
  ["TLS verification switched off in Node", input([file("src/x.js", patchWith("rejectUnauthorized: false"))]), /TLS verification/],
  ["an allow-all rule", input([file("src/policy.ts", patchWith("const allow_all = true"))]), /allows everything/],
  ["authentication switched off", input([file("src/server.ts", patchWith("disable_auth()"))]), /authentication or authorization switched off/],
  ["a private key", input([file("src/k.ts", patchWith("-----BEGIN RSA PRIVATE KEY-----"))]), /private key/],
  ["a GitHub token", input([file("src/k.ts", patchWith("const t = 'ghp_" + "a".repeat(36) + "'"))]), /GitHub token/],
  ["an AWS key", input([file("src/k.ts", patchWith("AKIAABCDEFGHIJKLMNOP"))]), /AWS/],
  ["a Kubernetes Secret", input([file("src/s.yaml", patchWith("kind: Secret"))]), /Kubernetes Secret/],
  ["a Dockerfile", input([file("Dockerfile")]), /release or deployment/],
  ["a chart", input([file("charts/app/values.yaml")]), /release or deployment/],
  ["terraform", input([file("infra/main.tf")]), /release or deployment/],
  ["an install script", input([file("scripts/install.sh")]), /release or deployment/],
  ["package scripts", input([file("package.json", patchWith('"postinstall": "node x.js"'))]), /package metadata/],
  ["a new dependency", input([file("package.json", patchWith('"left-pad": "^1.3.0"'))]), /dependency added/],
  ["a requirements line", input([file("requirements.txt", patchWith("requests>=2.31"))]), /dependency added/],
  ["a dependency from a git url", input([file("package.json", patchWith('"x": "git+https://example.invalid/x.git"'))]), /git or URL source/],
  ["a lock file alone", input([file("package-lock.json")]), /lock file/],
  ["more than 300 deleted lines", input([file("src/a.ts", undefined, { additions: 0, deletions: 301 })], { deletions: 301 }), /lines deleted/],
  ["mostly deletions", input([file("src/a.ts", undefined, { additions: 20, deletions: 120 })], { additions: 20, deletions: 120 }), /mostly deletions/],
  ["more than 1000 changed lines", input([file("src/a.ts")], { additions: 1001 }), /large change/],
  ["more than 40 files", input(Array.from({ length: 41 }, (_, i) => file(`src/f${i}.ts`))), /large change: 41 files/],
  ["more than 5 files deleted", input(Array.from({ length: 6 }, (_, i) => file(`src/f${i}.ts`, undefined, { status: "removed", additions: 0, deletions: 1 }))), /files deleted/],
  ["a test directory emptied", input(Array.from({ length: 3 }, (_, i) => file(`test/unit/t${i}.ts`, undefined, { status: "removed", additions: 0, deletions: 1 }))), /test files deleted/],
  ["a binary or too-large diff", input([file("data/model.bin", undefined, { patch: undefined, additions: 5000 })]), /not readable/],
  ["a submodule pointer", input([file("vendor/lib", "@@ -1 +1 @@\n-Subproject commit aaa\n+Subproject commit bbb")]), /submodule/],
  ["a file mode change", input([file("run.sh", undefined, { status: "changed" })]), /mode or type/],
  ["a fork", input([file("src/a.ts")], { fork: true }), /fork/],
  ["an author outside the organisation", input([file("src/a.ts")], { authorAssociation: "FIRST_TIME_CONTRIBUTOR" }), /not a member/],
  ["a base that is not the default branch", input([file("src/a.ts")], { baseRef: "releases" }), /base branch is releases/],
  ["a file list that was cut", input([file("src/a.ts")], { filesComplete: false, changedFiles: 600 }), /incomplete/],
  ["more files than GitHub lists", input([file("src/a.ts")], { changedFiles: 3500, filesComplete: false }), /3000/],
  ["a repository config that does not parse", input([file("src/a.ts")], { repoConfig: "invalid" }), /clawy\.yml could not be read/],
  ["a repository that asks for confirmation every time", input([file("src/a.ts")], { repoConfig: { confirmMerge: "always", highRiskPaths: [] } }), /every merge/],
  ["a path the repository marks", input([file("docs/legal/terms.md")], { repoConfig: { confirmMerge: "risk", highRiskPaths: ["docs/legal/**"] } }), /marks high risk/],
  ["a security finding the reviewer reports", input([file("src/a.ts")], { flags: ["security_finding"] }), /security issue/],
  ["a skipped review step the reviewer reports", input([file("src/a.ts")], { flags: ["review_skipped"] }), /skipped a step/],
];

for (const [name, i, why] of HIGH) {
  test(`high: ${name}`, () => {
    const r = assessRisk(i);
    assert.equal(r.level, "high");
    assert.match(r.reasons.join("\n"), why);
  });
}

const LOW: Array<[string, RiskInput]> = [
  ["source and tests", input([file("src/render.ts"), file("test/render.test.ts")])],
  ["documentation", input([file("docs/guide.md"), file("README.md")])],
  ["a manifest edit that adds no dependency", input([file("package.json", patchWith('"description": "A tool"'))])],
  ["a manifest and its lock together", input([file("package.json", patchWith('"description": "A tool"')), file("package-lock.json")])],
  ["a small deletion", input([file("src/a.ts", undefined, { additions: 1, deletions: 40 })], { additions: 1, deletions: 40 })],
  ["a file named like a secret word inside source code", input([file("src/author.ts")])],
  ["a word that only contains 'session' as a substring", input([file("src/obsessional.ts")])],
  ["a repository config with a path that does not match", input([file("src/a.ts")], { repoConfig: { confirmMerge: "risk", highRiskPaths: ["docs/legal/**"] } })],
  ["an owner of the repository", input([file("src/a.ts")], { authorAssociation: "OWNER" })],
  ["a collaborator", input([file("src/a.ts")], { authorAssociation: "COLLABORATOR" })],
];
for (const [name, i] of LOW) {
  test(`low: ${name}`, () => {
    assert.deepEqual(assessRisk(i).reasons, []);
  });
}

test("a rule that throws makes the verdict high, never low", () => {
  const hostile = { ...input([file("src/a.ts")]), files: null } as unknown as RiskInput;
  const r = assessRisk(hostile);
  assert.equal(r.level, "high");
  assert.match(r.reasons.join(), /could not be evaluated/);
});

test("the list of reasons is bounded and says how many more there were", () => {
  const files = Array.from({ length: 30 }, (_, i) => file(`.github/workflows/w${i}.yml`));
  const r = assessRisk(input(files));
  assert.equal(r.reasons.length, 21);
  assert.match(r.reasons.at(-1) ?? "", /and \d+ more/);
});

test("clawy.yml: the two keys are read, a comment and a blank line are fine, and anything else is invalid", () => {
  assert.deepEqual(parseClawyConfig("# note\nconfirm_merge: always\n\nhigh_risk_paths:\n  - \"docs/legal/**\"\n  - 'infra/*.yaml'\n"), { confirmMerge: "always", highRiskPaths: ["docs/legal/**", "infra/*.yaml"] });
  assert.deepEqual(parseClawyConfig(""), { confirmMerge: "risk", highRiskPaths: [] });
  for (const bad of ["confirm_merge: sometimes", "surprise: 1", "high_risk_paths: docs", "  - orphan", "confirm_merge: always\nbroken line"]) {
    assert.equal(parseClawyConfig(bad), "invalid", bad);
  }
});

test("globs: * stays inside a segment, ** crosses them, and regex characters are literal", () => {
  assert.equal(globToRegExp("docs/*.md").test("docs/a.md"), true);
  assert.equal(globToRegExp("docs/*.md").test("docs/x/a.md"), false);
  assert.equal(globToRegExp("docs/**").test("docs/x/y/a.md"), true);
  assert.equal(globToRegExp("a+b.txt").test("aab.txt"), false);
  assert.equal(globToRegExp("a+b.txt").test("a+b.txt"), true);
});

test("a file moved out of a protected path is judged by where it was, not only where it is", () => {
  const moved = (from: string, to: string): RiskFile => file(to, undefined, { status: "renamed", previousPath: from, patch: undefined, additions: 0, deletions: 0 });
  for (const [from, to, why] of [
    [".github/workflows/security-scan.yml", "docs/old/security-scan.yml", /workflow/],
    ["CODEOWNERS", "docs/CODEOWNERS.bak", /governance/],
    [".github/CODEOWNERS", "notes/owners.txt", /governance/],
    ["deploy/tls.pem", "docs/tls.txt", /secret-handling/],
    ["Dockerfile", "docs/Dockerfile.old", /release or deployment/],
    ["src/auth/login.ts", "src/login.ts", /authentication/],
    ["docs/legal/terms.md", "docs/terms.md", /marks high risk/],
  ] as const) {
    const r = assessRisk(input([moved(from, to)], { repoConfig: { confirmMerge: "risk", highRiskPaths: ["docs/legal/**"] } }));
    assert.equal(r.level, "high", `${from} -> ${to}`);
    assert.match(r.reasons.join("\n"), why, `${from} -> ${to}`);
    assert.equal(r.reasons.some((x) => x.includes(`${from} (moved to ${to})`)), true, `${from} -> ${to}`);
  }
  // A removed governance file is held too, and an ordinary rename is not.
  assert.equal(assessRisk(input([file(".github/workflows/ci.yml", undefined, { status: "removed", additions: 0, deletions: 4 })])).level, "high");
  assert.deepEqual(assessRisk(input([moved("src/a.ts", "src/b.ts")])).reasons, []);
});

test("a changed line that begins with ++ is read by the line rules like any other", () => {
  for (const line of ["+  chmod 777 /data", "+x; rejectUnauthorized: false", "+-----BEGIN RSA PRIVATE KEY-----"]) {
    assert.equal(assessRisk(input([file("src/x.sh", patchWith(line))])).level, "high", line);
  }
});
