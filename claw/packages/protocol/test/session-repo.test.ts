// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `config.repo`: what a client may bind a session to. The one check the API
 * runs at create time and Brain runs again before it builds a command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionRepo, sessionRepoDirName,
  SESSION_REPO_BRANCH_MAX_LENGTH, SESSION_REPO_NAME_MAX_LENGTH, SESSION_REPO_URL_MAX_LENGTH,
} from "../src/session-repo.js";

const GOOD_URLS: Array<[string, string, string]> = [
  ["github", "https://github.com/example-org/example-repo", "example-repo"],
  ["with .git", "https://github.com/example-org/example-repo.git", "example-repo"],
  ["any host", "https://git.example.invalid/team/tool", "tool"],
  ["host with a port", "https://git.example.invalid:8443/team/tool.git", "tool"],
  ["uppercase and digits", "https://GitHub.com/Example-Org2/Repo_1.v2", "Repo_1.v2"],
  ["dots and dashes in the name", "https://github.com/o/my.repo-name", "my.repo-name"],
  ["a name that merely contains .git", "https://github.com/o/a.github", "a.github"],
  ["a name that ends in .git twice", "https://github.com/o/r.git.git", "r.git"],
  ["the longest allowed name", `https://github.com/o/${"n".repeat(SESSION_REPO_NAME_MAX_LENGTH)}`, "n".repeat(SESSION_REPO_NAME_MAX_LENGTH)],
];

const BAD_URLS: Array<[string, unknown]> = [
  ["http, not https", "http://github.com/o/r"],
  ["ssh form", "git@github.com:o/r.git"],
  ["ssh scheme", "ssh://git@github.com/o/r.git"],
  ["git scheme", "git://github.com/o/r.git"],
  ["file scheme", "file:///etc/passwd"],
  ["a username", "https://user@github.com/o/r"],
  ["a username and password", "https://user:pass@github.com/o/r"],
  ["a token as the username", "https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/o/r"],
  ["an at-sign hiding the real host", "https://github.com@evil.example/o/r"],
  ["a query", "https://github.com/o/r?token=x"],
  ["a fragment", "https://github.com/o/r#main"],
  ["a space inside", "https://github.com/o/r r"],
  ["a space around it", " https://github.com/o/r"],
  ["a trailing space", "https://github.com/o/r "],
  ["a newline", "https://github.com/o/r\n"],
  ["a tab", "https://github.com/o/r\t"],
  ["a quote", "https://github.com/o/r'x"],
  ["a shell substitution", "https://github.com/o/$(id)"],
  ["a backtick", "https://github.com/o/`id`"],
  ["a semicolon", "https://github.com/o/r;id"],
  ["a backslash", "https://github.com/o\\r"],
  ["only an owner", "https://github.com/o"],
  ["a trailing slash", "https://github.com/o/r/"],
  ["three segments", "https://github.com/o/r/extra"],
  ["no host", "https:///o/r"],
  ["an ip literal in brackets", "https://[::1]/o/r"],
  ["an empty owner", "https://github.com//r"],
  ["a dot owner", "https://github.com/./r"],
  ["a dot-dot owner", "https://github.com/../r"],
  ["a dot-dot name", "https://github.com/o/.."],
  ["a hidden name", "https://github.com/o/.github"],
  ["a name that is only .git", "https://github.com/o/.git"],
  ["a name starting with a dot, then .git", "https://github.com/o/.hidden.git"],
  ["a name over the limit", `https://github.com/o/${"n".repeat(SESSION_REPO_NAME_MAX_LENGTH + 1)}`],
  ["a url over the limit", `https://github.com/o/${"n".repeat(SESSION_REPO_URL_MAX_LENGTH)}`],
  ["a port that is not digits", "https://github.com:abc/o/r"],
  ["a port over five digits", "https://github.com:123456/o/r"],
  ["an empty string", ""],
  ["a number", 5],
  ["a boolean", true],
  ["an object", { href: "https://github.com/o/r" }],
  ["an array", ["https://github.com/o/r"]],
];

const GOOD_BRANCHES = [
  "main", "master", "develop", "feat/session-repo-binding", "release-1.2", "release/1.2.x", "user/fix_1",
  "v1.0.0", "a", "_x", "9lives", "fix+plus", "a.b", "claw/ckpt/12",
  "b".repeat(SESSION_REPO_BRANCH_MAX_LENGTH),
];

const BAD_BRANCHES: Array<[string, unknown]> = [
  ["a leading dash (an option)", "-f"],
  ["a leading dash then a word", "--upload-pack=x"],
  ["a leading slash", "/main"],
  ["a leading dot", ".hidden"],
  ["dot-dot", "a..b"],
  ["dot-dot as a component", "../main"],
  ["a double slash", "a//b"],
  ["a component starting with a dot", "a/.b"],
  ["a trailing slash", "main/"],
  ["a trailing dot", "main."],
  ["a .lock suffix", "main.lock"],
  ["a .lock component", "a.lock/b"],
  ["a space", "my branch"],
  ["a trailing space", "main "],
  ["a newline", "main\nx"],
  ["a tab", "main\tx"],
  ["a control character", "main\u0007"],
  ["a nul", "main\u0000"],
  ["a tilde", "main~1"],
  ["a caret", "main^"],
  ["a colon", "a:b"],
  ["a question mark", "a?"],
  ["a star", "a*"],
  ["a bracket", "a[0]"],
  ["a backslash", "a\\b"],
  ["an at-brace", "a@{1}"],
  ["a quote", "a'b"],
  ["a dollar", "a$b"],
  ["a semicolon", "a;b"],
  ["a backtick", "a`b`"],
  ["non-ASCII", "分支"],
  ["over the limit", "b".repeat(SESSION_REPO_BRANCH_MAX_LENGTH + 1)],
  ["a number", 1],
  ["a boolean", false],
  ["an array", ["main"]],
  ["an object", { name: "main" }],
];

const URL = "https://github.com/example-org/example-repo";

for (const [label, url, name] of GOOD_URLS) {
  test(`url accepted: ${label}`, () => {
    const r = parseSessionRepo({ url });
    assert.deepEqual(r, { ok: true, repo: { url } });
    assert.equal(sessionRepoDirName({ url }), name);
  });
}

for (const [label, url] of BAD_URLS) {
  test(`url refused: ${label}`, () => {
    const r = parseSessionRepo({ url });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /^config\.repo\.url /);
      // The message describes the rule; it never repeats the value, which may hold a credential.
      if (typeof url === "string" && url.length > 8) assert.equal(r.error.includes(url), false);
    }
    if (typeof url === "string") assert.equal(sessionRepoDirName({ url }), null, "and it names no directory");
  });
}

for (const branch of GOOD_BRANCHES) {
  test(`branch accepted: ${branch.slice(0, 40)}`, () => {
    assert.deepEqual(parseSessionRepo({ url: URL, branch }), { ok: true, repo: { url: URL, branch } });
  });
}

for (const [label, branch] of BAD_BRANCHES) {
  test(`branch refused: ${label}`, () => {
    const r = parseSessionRepo({ url: URL, branch });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /^config\.repo\.branch /);
  });
}

test("the url length limit is its own check: a url over it is refused though every part is well formed", () => {
  const host = (n: number) => `https://${"a".repeat(n)}.example.invalid/o/r`;
  // 512 characters exactly: accepted. One more: refused, with the length message and not the shape one.
  const exactly = host(SESSION_REPO_URL_MAX_LENGTH - "https://".length - ".example.invalid/o/r".length);
  assert.equal(exactly.length, SESSION_REPO_URL_MAX_LENGTH);
  assert.deepEqual(parseSessionRepo({ url: exactly }), { ok: true, repo: { url: exactly } });
  const over = host(SESSION_REPO_URL_MAX_LENGTH - "https://".length - ".example.invalid/o/r".length + 1);
  const r = parseSessionRepo({ url: over });
  assert.deepEqual(r, { ok: false, error: `config.repo.url must be at most ${SESSION_REPO_URL_MAX_LENGTH} characters` });
});

test("an empty or null branch means the remote's default and is left out of the result", () => {
  assert.deepEqual(parseSessionRepo({ url: URL, branch: "" }), { ok: true, repo: { url: URL } });
  assert.deepEqual(parseSessionRepo({ url: URL, branch: null }), { ok: true, repo: { url: URL } });
  assert.deepEqual(parseSessionRepo({ url: URL }), { ok: true, repo: { url: URL } });
});

test("no value, or null, means no repository", () => {
  assert.deepEqual(parseSessionRepo(undefined), { ok: true, repo: null });
  assert.deepEqual(parseSessionRepo(null), { ok: true, repo: null });
});

test("the shape is exact: other types, a missing url and unknown keys are refused", () => {
  for (const raw of ["https://github.com/o/r", 5, true, [], [{ url: URL }]]) {
    const r = parseSessionRepo(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) assert.equal(r.error, "config.repo must be an object with a url and an optional branch");
  }
  const missing = parseSessionRepo({});
  assert.deepEqual(missing, { ok: false, error: "config.repo.url is required" });
  assert.deepEqual(parseSessionRepo({ branch: "main" }), { ok: false, error: "config.repo.url is required" });
  assert.deepEqual(parseSessionRepo({ url: URL, setup: "npm ci" }), { ok: false, error: "config.repo.setup is not supported" });
  assert.deepEqual(parseSessionRepo({ url: URL, token: "x" }), { ok: false, error: "config.repo.token is not supported" });
  assert.deepEqual(parseSessionRepo({ url: 5 }), { ok: false, error: "config.repo.url must be a string" });
});
