// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a finding goes (relocate.ts): placed by the code it quotes when its line is off, and a re-review's finding that repeats an open
 * thread of the last review said in the body instead of a second thread.
 *
 *   P  placing by `existing_code`, alone
 *   S  through gh_review_submit
 */
import assert from "node:assert/strict";
import test, { after, afterEach, describe } from "node:test";
import { headLines, locateCode, placeComment, repeatsOpenFinding } from "../src/github-review/relocate.js";
import { HEAD } from "./support/fake-github.js";
import { PR, closeShared, reviewEnv, type ReviewEnv } from "./support/review-env.js";

const PATCH = [
  "@@ -10,6 +10,9 @@ export function run() {",
  "   const a = read();",
  "-  if (a) go(a);",
  "+  if (a !== undefined) {",
  "+    go(a);",
  "+  }",
  "",
  "   return done(a);",
  "@@ -40,3 +43,4 @@",
  "   const b = read();",
  "+  go(a);",
  "   return b;",
].join("\n");

describe("P placing by the code", () => {
  test("P1 the head-side lines of a patch, numbered as in the new file: context and added lines, a blank context line included", () => {
    const h = headLines(PATCH);
    assert.deepEqual([...h.keys()], [10, 11, 12, 13, 14, 15, 43, 44, 45]);
    assert.equal(h.get(11), "  if (a !== undefined) {");
    assert.equal(h.get(14), "");
  });

  test("P2 code is found where the diff shows it, nearest to the given line; a mark copied from the diff is ignored", () => {
    assert.equal(locateCode(PATCH, "if (a !== undefined) {", 30), 11);
    assert.equal(locateCode(PATCH, "+  if (a !== undefined) {\n+    go(a);", 1), 11);
    assert.equal(locateCode(PATCH, "go(a);", 40), 44, "two places: the nearer one");
    assert.equal(locateCode(PATCH, "go(a);", 10), 12);
    assert.equal(locateCode(PATCH, "if (a) go(a);", 11), null, "a removed line is not on the head side");
    assert.equal(locateCode(PATCH, "}", 13), null, "too short to place anything");
    assert.equal(locateCode(PATCH, "return done(a);\nreturn b;", 15), null, "lines that do not follow one another");
    assert.equal(locateCode(PATCH, "return done(a);\nconst b = read();", 15), null, "the last line of one hunk and the first of the next are not adjacent in the file");
    assert.equal(locateCode(PATCH, "    go(a);\n  }\n\n  return done(a);", 1), 12, "a blank line between is skipped");
  });

  test("P3 a comment stays where its line shows the code, or anywhere inside the code's lines; else it moves, and code not in the diff moves nothing", () => {
    assert.deepEqual(placeComment(PATCH, 11, "if (a !== undefined) {"), { line: 11, movedFrom: null });
    assert.deepEqual(placeComment(PATCH, 12, "if (a !== undefined) {\n    go(a);\n  }"), { line: 12, movedFrom: null });
    assert.deepEqual(placeComment(PATCH, 20, "if (a !== undefined) {"), { line: 11, movedFrom: 20 });
    assert.deepEqual(placeComment(PATCH, 20, "nothing like it"), { line: 20, movedFrom: null });
    assert.deepEqual(placeComment(PATCH, 20, undefined), { line: 20, movedFrom: null });
  });

  test("P4 a finding repeats an open thread of the last review on the same file within a few lines; a resolved one or one without a thread does not count", () => {
    const open = [
      { path: "src/app.ts", line: 10, thread_id: "T1", resolved: false },
      { path: "src/app.ts", line: 30, thread_id: "T2", resolved: true },
      { path: "src/app.ts", line: 50, thread_id: null, resolved: false },
    ];
    assert.equal(repeatsOpenFinding(open, "src/app.ts", 12)?.thread_id, "T1");
    assert.equal(repeatsOpenFinding(open, "src/app.ts", 14), null);
    assert.equal(repeatsOpenFinding(open, "src/other.ts", 10), null);
    assert.equal(repeatsOpenFinding(open, "src/app.ts", 30), null);
    assert.equal(repeatsOpenFinding(open, "src/app.ts", 50), null);
  });
});

describe("S through gh_review_submit", () => {
  let e: ReviewEnv;
  afterEach(async () => { await e?.close(); });
  after(closeShared);
  const LOW = { level: "low", reason: "an ordinary change" };
  const posted = () => e.gh.writes.filter((w) => w.path === "/repos/AMD-AGI/demo/pulls/7/reviews");
  const submit = (over: Record<string, unknown>) => e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "REQUEST_CHANGES", body: "Read all of it.", risk_judgement: LOW, ...over });

  test("S1 an inline comment whose line is off is posted on the code it quotes, and the result says it moved; one outside the diff without code is still refused", async () => {
    e = await reviewEnv();
    e.gh.files[0]!.patch = "@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = read();\n+const c = b + 1;\n return a;";
    const o = await submit({ comments: [{ path: "src/app.ts", line: 40, body: "c is never checked", existing_code: "c" }] });
    assert.equal(o.isError, true, "one character places nothing: still outside the diff");
    const moved = await submit({ comments: [{ path: "src/app.ts", line: 40, body: "c drops the error of read()", existing_code: "+const c = b + 1;" }] });
    assert.equal(moved.isError, false, moved.text);
    assert.deepEqual(posted()[0]?.body.comments, [{ path: "src/app.ts", line: 3, side: "RIGHT", body: "c drops the error of read()" }]);
    assert.deepEqual(moved.body.moved_comments, [{ path: "src/app.ts", from: 40, to: 3 }]);
  });

  test("S1b a note is listed with the line of the code it quotes", async () => {
    e = await reviewEnv();
    e.gh.files[0]!.patch = "@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = read();\n+const c = b + 1;\n return a;";
    const o = await submit({ event: "COMMENT", non_blocking: [{ path: "src/app.ts", line: null, body: "read() can throw", existing_code: "const b = read();" }] });
    assert.equal(o.isError, false, o.text);
    assert.match(posted()[0]?.body.body, /- `src\/app\.ts:2`: read\(\) can throw/);
  });

  test("S2 a re-review does not open a second thread where the last review's is still open: the finding goes in the body, and the result says so", async () => {
    e = await reviewEnv({}, { deps: { continuationOf: async () => ({ sinceHeadSha: HEAD, findings: [{ path: "src/app.ts", line: 3, thread_id: "PRRT_kwDO1", note: "c", resolved: false }] }) } });
    e.gh.files[0]!.patch = "@@ -1,4 +1,8 @@\n a\n-b\n+b2\n+c\n+d\n+e2\n+e3\n e\n f";
    const o = await submit({ comments: [
      { path: "src/app.ts", line: 4, body: "c is still never checked" },
      { path: "src/app.ts", line: 7, body: "e3 is new and wrong" },
    ] });
    assert.equal(o.isError, false, o.text);
    assert.deepEqual(posted()[0]?.body.comments, [{ path: "src/app.ts", line: 7, side: "RIGHT", body: "e3 is new and wrong" }]);
    assert.match(posted()[0]?.body.body, /\*\*Still open from the last review\*\*\n- `src\/app\.ts:4`: c is still never checked/);
    assert.deepEqual(o.body.said_in_body_as_still_open, [{ path: "src/app.ts", line: 4, thread_id: "PRRT_kwDO1" }]);
  });

  test("S3 a re-review whose only inline finding repeats an open thread still requests changes, with the finding in the body", async () => {
    e = await reviewEnv({}, { deps: { continuationOf: async () => ({ sinceHeadSha: HEAD, findings: [{ path: "src/app.ts", line: 3, thread_id: "PRRT_kwDO1", note: "c", resolved: false }] }) } });
    const o = await submit({ comments: [{ path: "src/app.ts", line: 3, body: "c is still never checked" }] });
    assert.equal(o.isError, false, o.text);
    assert.equal(posted()[0]?.body.event, "REQUEST_CHANGES");
    assert.equal(posted()[0]?.body.comments, undefined);
    assert.match(posted()[0]?.body.body, /\*\*Still open from the last review\*\*\n- `src\/app\.ts:3`: c is still never checked/);
  });
});
