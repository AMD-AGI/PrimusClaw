// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an approval notification says is being approved: the command or the tool
 * with its salient inputs, masked first and cut second, never longer than 300.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_TARGET_MAX, approvalTarget, redactCommandSecrets } from "../src/notifications/approval-target.js";

const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

// Each row: a command, and a string that must NOT survive in the target.
const SECRET_COMMANDS: Array<[string, string, string]> = [
  ["a vendor token in an env assignment", `GH_TOKEN=${GH} git push`, GH],
  ["a plain value in a secret-named variable", "GH_TOKEN=abc123xyz git push origin main", "abc123xyz"],
  ["a password variable", "export DB_PASSWORD=hunter2 && ./migrate", "hunter2"],
  ["a quoted secret value", `API_KEY="s3cr3t value with spaces" ./run`, "s3cr3t value"],
  ["a lower-case secret name", "my_token=zzz111 ./run", "zzz111"],
  ["a name that is only the keyword", "TOKEN=zzz222 ./run", "zzz222"],
  ["a --token flag", "tool --token abc123def456 run", "abc123def456"],
  ["a --token=value flag", "kubectl --token=abcdef123456 get pods", "abcdef123456"],
  ["a --password flag", "mysql --password hunter2 -e 'select 1'", "hunter2"],
  ["a bearer header", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://x.example.invalid", "abcdefghijklmnopqrstuvwxyz0123"],
  ["basic auth", "curl -u admin:hunter2 https://x.example.invalid", "hunter2"],
  ["basic auth, long form", "curl --user admin:hunter2 https://x.example.invalid", "hunter2"],
  ["userinfo in a url", "git push https://user:s3cretpass@github.com/o/r.git main", "s3cretpass"],
  ["a token as the userinfo", `git push https://x-access-token:${GH}@github.com/o/r`, GH],
  ["a database url", "psql postgres://u:pw123456@db.example.invalid/x", "pw123456"],
  ["a json password field", `curl -d '{"password": "hunter2", "user": "a"}' https://x.example.invalid`, "hunter2"],
  ["a vendor token standing alone", `echo ${GH}`, GH],
];

for (const [label, command, secret] of SECRET_COMMANDS) {
  test(`bash target masks ${label}`, () => {
    const target = approvalTarget("bash", { command });
    assert.equal(target.includes(secret), false, target);
    assert.ok(target.length <= APPROVAL_TARGET_MAX);
    assert.match(target, /redacted/i, "and says that something was masked");
  });
}

test("a command with nothing secret in it comes through as it was written, on one line", () => {
  assert.equal(approvalTarget("bash", { command: "git push origin feat/x" }), "git push origin feat/x");
  assert.equal(approvalTarget("bash", { command: "cd /workspace/app &&\n  git push -u origin HEAD" }), "cd /workspace/app && git push -u origin HEAD");
  assert.equal(approvalTarget("Bash", { command: "gh pr create --fill" }), "gh pr create --fill", "the tool name is not case-sensitive");
  assert.equal(approvalTarget("bash", { command: "  rm -rf /tmp/x  " }), "rm -rf /tmp/x");
  for (const harmless of ["git status", "echo PASSWORDS are mentioned here", "ls --all", "grep -r token docs/"]) {
    assert.equal(approvalTarget("bash", { command: harmless }), harmless, harmless);
  }
});

test("a bash call without a command says only that it is bash", () => {
  assert.equal(approvalTarget("bash", {}), "bash");
  assert.equal(approvalTarget("bash", { command: 5 }), "bash");
  assert.equal(approvalTarget("bash", null), "bash");
  assert.equal(approvalTarget("bash", "git push"), "bash");
});

test("the target is cut at 300 characters with an ellipsis, never more", () => {
  const long = `echo ${"word ".repeat(200)}`;
  const t = approvalTarget("bash", { command: long });
  assert.equal(t.length, APPROVAL_TARGET_MAX);
  assert.ok(t.endsWith("…"));
  assert.ok(t.startsWith("echo word word"));
  const exact = "x".repeat(APPROVAL_TARGET_MAX);
  assert.equal(approvalTarget("bash", { command: exact }), exact, "exactly 300 is not cut");
  assert.equal(approvalTarget("bash", { command: exact + "y" }).length, APPROVAL_TARGET_MAX);
  assert.equal(approvalTarget("bash", { command: "x".repeat(500_000) }).length, APPROVAL_TARGET_MAX, "a huge command is cut without scanning all of it");
});

test("a secret that would straddle the cut is masked, not half shown", () => {
  const prefix = "a".repeat(290);
  const t = approvalTarget("bash", { command: `${prefix} --token abcdefghijklmnopqrstuvwxyz` });
  assert.equal(t.includes("abcdefg"), false, t);
  assert.ok(t.length <= APPROVAL_TARGET_MAX);
  const vendor = approvalTarget("bash", { command: `${"b".repeat(285)} ${GH}` });
  assert.equal(vendor.includes("ghp_0123"), false, vendor);
});

test("an MCP tool: its name and the salient inputs", () => {
  assert.equal(
    approvalTarget("mcp__jobs__create_run", { plan_id: "p-1", gpus: 8, dry_run: false }),
    "mcp__jobs__create_run plan_id=p-1 gpus=8 dry_run=false",
  );
  assert.equal(approvalTarget("mcp__board__post", {}), "mcp__board__post");
  assert.equal(approvalTarget("mcp__board__post", null), "mcp__board__post");
  assert.equal(approvalTarget("mcp__x__y", { a: null, b: "", c: undefined, d: 1 }), "mcp__x__y d=1", "empty values say nothing");
});

test("an MCP tool: at most six fields, long values and nested ones clipped, whitespace collapsed", () => {
  const input = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };
  assert.equal(approvalTarget("t", input), "t a=1 b=2 c=3 d=4 e=5 f=6");
  const long = approvalTarget("t", { body: "z".repeat(500) });
  assert.equal(long.length, "t body=".length + 80);
  assert.ok(long.endsWith("…"));
  assert.equal(approvalTarget("t", { cfg: { a: 1, b: [1, 2] } }), 't cfg={"a":1,"b":[1,2]}');
  assert.equal(approvalTarget("t", { note: "line one\n   line two" }), "t note=line one line two");
});

test("an MCP tool: credential-looking keys keep their name and lose their value; secret shapes in values are masked", () => {
  const t = approvalTarget("mcp__x__call", { api_key: "k-123456789", password: "hunter2", url: "https://u:pw123456@h.example.invalid/x", note: `see ${GH}` });
  for (const secret of ["k-123456789", "hunter2", "pw123456", GH]) assert.equal(t.includes(secret), false, t);
  assert.match(t, /api_key=<redacted>/);
  assert.match(t, /password=<redacted>/);
  assert.ok(t.length <= APPROVAL_TARGET_MAX);
});

test("an MCP tool: a value under a credential-like key is masked by the key's name alone", () => {
  // None of these values has a shape the general patterns know, and none of the
  // names is one the command-line patterns (TOKEN, SECRET, PASSWORD, ...) match.
  const t = approvalTarget("mcp__x__call", { cookie: "sid=abc123def", passphrase: "correct horse", authorization: "Basic YWxpY2U6cHc=", auth: "xyz987", credential: "plainvalue1" });
  for (const secret of ["abc123def", "correct horse", "YWxpY2U6cHc=", "xyz987", "plainvalue1"]) assert.equal(t.includes(secret), false, t);
  assert.match(t, /cookie=\[REDACTED\]/);
  assert.match(t, /auth=\[REDACTED\]/);
});

test("a tool that is not a string, and input that is not an object, never throw", () => {
  assert.equal(approvalTarget(undefined, { a: 1 }), " a=1".trim());
  assert.equal(approvalTarget(5, undefined), "");
  assert.equal(approvalTarget("t", "just a string"), "t");
  assert.equal(approvalTarget("t", [1, 2, 3]), "t");
  assert.doesNotThrow(() => approvalTarget("t", { self: Object.create(null) }));
});

test("redactCommandSecrets is idempotent and leaves ordinary text alone", () => {
  const once = redactCommandSecrets(`GH_TOKEN=abc123 curl -u a:b https://h --token zzz`);
  assert.equal(redactCommandSecrets(once), once);
  assert.equal(redactCommandSecrets("git log --oneline -5"), "git log --oneline -5");
});
