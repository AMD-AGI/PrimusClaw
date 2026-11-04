// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What this feature adds to a public repository: no internal names, the default
 * skill kept identical in its two places, and nothing registered while the feature
 * is off.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { FIXED_REVIEW_RULES, PR_REVIEW_INSTRUCTIONS, PR_REVIEW_SKILL } from "../src/github-review/default-skill.js";

const root = new URL("../../..", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const OWN_FILES = [
  ...walk(join(root, "packages/api/src/github-review")),
  ...walk(join(root, "examples/skills/pr-review")),
  join(root, "docs/github-review.md"),
  ...walk(join(root, "packages/api/test/support")).filter((f) => /fake-github|review-env/.test(f)),
  ...readdirSync(join(root, "packages/api/test")).filter((f) => f.startsWith("github-review-")).map((f) => join(root, "packages/api/test", f)),
  join(root, "packages/utils/src/identity/credentials.ts"),
  join(root, "packages/utils/test/identity-credentials.test.ts"),
  // What a service that acts for a person may bring with its token: the auth code, its documentation and its tests.
  join(root, "packages/api/src/auth/identity-token.ts"),
  join(root, "packages/api/src/auth/delegated-keys.ts"),
  join(root, "docs/identity-client.md"),
  join(root, "packages/api/test/identity-token-safe-keys.test.ts"),
  join(root, "packages/api/test/identity-token-middleware.test.ts"),
  // What a session that acts as a user is not given: its sandbox's keys.
  join(root, "packages/brain/test/ensure-hands-acting-session-keys.test.ts"),
  join(root, "packages/brain/test/ensure-hands-acting-session-keys-k8s.test.ts"),
];

/**
 * What this change adds on top of the tree above, and what it is written without: the name of the chat service that is the first
 * user of it. The service is a client id an operator writes down; nothing in the public tree is written for it. (The review feature
 * itself still names it in places, which is not this list's business: they are not in it.)
 */
const NEUTRAL_FILES = [
  join(root, "packages/api/src/auth/identity-token.ts"),
  join(root, "packages/api/src/auth/delegated-keys.ts"),
  join(root, "packages/api/src/github-review/session-tools.ts"),
  join(root, "docs/identity-client.md"),
  join(root, "packages/api/test/identity-token-safe-keys.test.ts"),
  join(root, "packages/api/test/identity-token-middleware.test.ts"),
  join(root, "packages/api/test/github-review-session.test.ts"),
  join(root, "packages/api/test/github-review-acting-turns.test.ts"),
  join(root, "packages/api/test/github-review-own-key-chain.test.ts"),
  join(root, "packages/api/test/github-review-acting-dispatch-keys.test.ts"),
  join(root, "packages/brain/test/ensure-hands-acting-session-keys.test.ts"),
  join(root, "packages/brain/test/ensure-hands-acting-session-keys-k8s.test.ts"),
];

test("the default skill is the same text as the skill file anyone can import", () => {
  assert.equal(PR_REVIEW_SKILL, readFileSync(join(root, "examples/skills/pr-review/SKILL.md"), "utf8"));
  assert.match(PR_REVIEW_SKILL, /^---\nname: pr-review\n/);
});

test("the skill file is a valid skill whose body is the instructions the model reads, and the instructions have no frontmatter", () => {
  const file = readFileSync(join(root, "examples/skills/pr-review/SKILL.md"), "utf8");
  const head = /^---\nname: pr-review\ndescription: [^\n]+\n---\n\n/.exec(file);
  assert.ok(head, "SKILL.md opens with a skill frontmatter (name and description)");
  assert.equal(file.slice(head[0].length), PR_REVIEW_INSTRUCTIONS, "one text, not two");
  assert.equal(PR_REVIEW_SKILL, head[0] + PR_REVIEW_INSTRUCTIONS);
  assert.doesNotMatch(PR_REVIEW_INSTRUCTIONS, /^---/);
  assert.doesNotMatch(PR_REVIEW_INSTRUCTIONS, /^(name|description): /m);
  assert.match(PR_REVIEW_INSTRUCTIONS, /^# Pull request review/);
  assert.doesNotMatch(PR_REVIEW_INSTRUCTIONS, /\b(use|using|with) the `?pr-review`? skill\b/i);
});

test("the skill ends its answer with one verdict line a caller can read, and nothing in a tool contradicts it", () => {
  assert.match(PR_REVIEW_SKILL, /exactly one last line, nothing after it/);
  for (const v of ["VERDICT: CLEAN", "VERDICT: BLOCKING", "VERDICT: NOT_REVIEWED"]) assert.ok(PR_REVIEW_SKILL.includes(`\`${v}\``), v);
  const mcp = readFileSync(join(root, "packages/api/src/github-review/mcp.ts"), "utf8");
  assert.doesNotMatch(mcp, /VERDICT:|last line|final answer|end (the|your) answer/i);
});

test("the fixed rules are the skill's rules without its steps, and they say what never changes", () => {
  assert.match(FIXED_REVIEW_RULES, /^# Pull request review/);
  assert.match(FIXED_REVIEW_RULES, /You only read and comment/);
  assert.match(FIXED_REVIEW_RULES, /request\s+reviewers/);
  assert.doesNotMatch(FIXED_REVIEW_RULES, /## Steps/);
});

/**
 * Where the product name of the chat integration may still appear: the names an earlier release wrote and this one only reads
 * (legacy-names.ts), and the one line of the documentation that says so. Anywhere else it is a layering break: the platform does not name the
 * clients that call it.
 */
const LEGACY_NAME_LINES: Array<{ file: string; line: RegExp }> = [
  { file: "packages/api/src/github-review/legacy-names.ts", line: /^export const LEGACY_[A-Z_]+ = "[^"]+";$/ },
  { file: "docs/github-review.md", line: /^- Earlier release names, still read and never written: / },
];

test("nothing this feature adds names an internal product, repository or host", () => {
  // Built from pieces so that this file does not contain what it looks for; compared as plain lower-case text, not as patterns.
  const product = ["cla", "wy"].join("");
  const forbidden = [
    ["te", "ams"], ["amd-brain", "-internal"], ["primus-safe", ".amd.com"], ["cru", "soe"], ["dis", "patron"], ["wst", "unnel"], [product],
  ].map((parts) => parts.join(""));
  const used = new Set<RegExp>();
  for (const f of OWN_FILES) {
    const exempt = LEGACY_NAME_LINES.filter((x) => x.file === relative(root, f));
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const word of forbidden) {
        if (!lower.includes(word)) continue;
        const hit = word === product ? exempt.find((x) => x.line.test(line)) : undefined;
        if (hit) used.add(hit.line);
        assert.ok(hit, `${f}:${i + 1} mentions ${word}`);
      }
    });
  }
  // An exemption nothing uses is a hole kept open for nothing.
  for (const x of LEGACY_NAME_LINES) assert.ok(used.has(x.line), `no line uses the exemption for ${x.file}`);
});

test("what a service that acts for a person may bring, and the sandbox keys a session that acts as a user is not given, name no chat service", () => {
  // Built from pieces so that this file does not contain what it looks for.
  const word = ["cla", "wy"].join("");
  for (const f of NEUTRAL_FILES) assert.equal(readFileSync(f, "utf8").toLowerCase().includes(word), false, `${f} mentions ${word}`);
});

test("every new source file carries the licence header", () => {
  for (const f of OWN_FILES.filter((p) => p.endsWith(".ts"))) {
    assert.match(readFileSync(f, "utf8").slice(0, 120), /Copyright Advanced Micro Devices, Inc\.\n.*SPDX-License-Identifier: MIT/s, f);
  }
});

test("the schema, the routes and the session tools are wired behind the flag, and the flag defaults off", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  assert.match(read("packages/api/src/config.ts"), /CLAW_GITHUB_REVIEW_ENABLED = envBool\("CLAW_GITHUB_REVIEW_ENABLED", false\)/);
  assert.match(read("packages/api/src/infra/db.ts"), /if \(CLAW_GITHUB_REVIEW_ENABLED\) await ensureGithubReviewSchema\(client\)/);
  assert.match(read("packages/api/src/index.ts"), /await registerGithubReviewRoutes\(app\)/);
  assert.match(read("packages/api/src/index.ts"), /assertGithubReviewConfig\(\)/);
  assert.match(read("packages/api/src/index.ts"), /githubReviewConfigErrors\(settings, identityClient\(\) !== null, identityTokenSettings\(\)\.ownKeyClientIds\)/);
  assert.match(read("packages/api/src/github-review/mcp.ts"), /if \(!\(opts\.enabled \?\? CLAW_GITHUB_REVIEW_ENABLED\)\) return;/);
  assert.match(read("packages/api/src/github-review/session-tools.ts"), /if \(!CLAW_GITHUB_REVIEW_ENABLED\) return \{\};/);
  assert.match(read("packages/api/src/github-review/acting-session.ts"), /config\.acting_as is not enabled on this deployment/);
  assert.match(read("packages/api/src/routes/sessions.ts"), /checkSessionCreate\(/);
  assert.match(read("packages/api/src/sessions/app-mcp.ts"), /githubReviewMcpServers\(sessionId\)/);
});
