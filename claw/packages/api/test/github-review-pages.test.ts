// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `gh_pr_get` in pages: a model whose every tool result is cut past 6000 characters (Brain's `TOOL_RESULT_MAX_CHARS`) still reads the
 * whole change and the whole review instructions, within the session's GitHub request budget.
 *
 *   G1  a pull request of about 1800 changed lines, read the way the tool tells the model to: every answer fits, every hunk is read, and
 *       the calls and the GitHub requests stay within the budget
 *   G2  the review instructions reach the model whole, the default ones and a repository's long skill
 *   G3  a page costs one GitHub request, from what the session read of that head; another session reads for itself
 *   G4  a head that moved refuses the page, and the next overview reads the new head
 *   G5  `file` and `max_diff_chars` narrow a page, which still fits
 *   G6  an overview too long for one answer is itself read in pages
 *   G7  a page fits whatever the text costs to escape, and a line longer than a page is still read whole
 */
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { PR_REVIEW_SKILL } from "../src/github-review/default-skill.js";
import { PAGE_MAX_CHARS, diffText, fitPage } from "../src/github-review/pages.js";
import type { RiskFile } from "../src/github-review/risk.js";
import { HEAD, type FakeFile } from "./support/fake-github.js";
import { PR, closeShared, readSection, reviewEnv, type ReviewEnv } from "./support/review-env.js";

/** Brain's cut (brain/src/agent/agent-loop.ts): a longer result reaches the model with its middle missing. */
const BRAIN_CUT = 6000;

let e: ReviewEnv;
beforeEach(async () => { e = await reviewEnv(); });
afterEach(async () => { await e.close(); });
after(closeShared);

/** `files` files of three hunks each; every changed line is unique and full of what JSON escapes. */
function bigChange(files: number, linesPerHunk: number): FakeFile[] {
  return Array.from({ length: files }, (_, f) => {
    const hunks: string[] = [];
    let added = 0;
    let removed = 0;
    for (let h = 0; h < 3; h++) {
      const body: string[] = [` function context_${f}_${h}() {`];
      for (let i = 0; i < linesPerHunk; i++) {
        const mark = i % 3 === 0 ? "-" : "+";
        if (mark === "+") added++; else removed++;
        body.push(`${mark}  const v_${f}_${h}_${i} = call("src/m${f}.ts", ${i}, "quote \\"${i}\\"", '\\t\\\\'); // line ${f}.${h}.${i}`);
      }
      body.push(" }");
      const start = 1 + h * 100;
      hunks.push(`@@ -${start},${body.length} +${start},${body.length} @@ hunk ${f}.${h}\n${body.join("\n")}`);
    }
    return { filename: `src/module_${f}/file_${f}.ts`, status: "modified", additions: added, deletions: removed, patch: hunks.join("\n") };
  });
}

/** The files as the service holds them: what the diff the model reads is built from. */
const asRead = (files: FakeFile[]): RiskFile[] => files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch }));

function useChange(files: FakeFile[]): void {
  e.gh.files = files;
  e.gh.pr.changed_files = files.length;
  e.gh.pr.additions = files.reduce((n, f) => n + f.additions, 0);
  e.gh.pr.deletions = files.reduce((n, f) => n + f.deletions, 0);
}

/**
 * The model's side, scripted the way the tool description and the default skill tell it to read: the overview, then every section the
 * overview does not hold, page after page. Every answer is what the model would see, so each is checked against Brain's cut.
 */
async function readLikeTheModel(): Promise<{ calls: number; texts: Record<string, string>; longest: number }> {
  const answers: string[] = [];
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const o = await e.service.getPr(e.actor, { pr: PR, ...args });
    answers.push(o.text);
    assert.equal(o.isError, false, o.text.slice(0, 300));
    return o.text;
  };
  // Only what reaches the model: the overview is JSON; a page is a line of JSON, then the page's text.
  const overview = JSON.parse(await call({}));
  const texts: Record<string, string> = {};
  for (const [section, info] of Object.entries(overview.sections as Record<string, { inline: boolean }>)) {
    if (info.inline) { texts[section] = section === "instructions" ? overview.review_instructions : overview.untrusted[section]; continue; }
    texts[section] = "";
    for (let offset: number | null = 0; offset !== null;) {
      const text = await call({ section, head_sha: overview.pull_request.head_sha, offset });
      const nl = text.indexOf("\n");
      const head = JSON.parse(text.slice(0, nl));
      assert.equal(head.offset, offset);
      texts[section] += text.slice(nl + 1);
      offset = head.next_offset;
    }
  }
  return { calls: answers.length, texts, longest: Math.max(...answers.map((t) => t.length)) };
}

test("G1 a pull request of about 1800 changed lines is read whole within the request budget, and no answer is cut", async () => {
  const files = bigChange(24, 25);
  useChange(files);
  assert.equal(e.gh.pr.additions + e.gh.pr.deletions, 1800);
  assert.equal(e.settings.requestsPerSession, 60, "the budget the session had when #228 ran out");
  const read = await readLikeTheModel();
  assert.ok(read.longest <= PAGE_MAX_CHARS && PAGE_MAX_CHARS < BRAIN_CUT, `longest answer ${read.longest}`);
  // Every hunk and every changed line, in order and nothing in between lost: the pages put together are the diff.
  assert.equal(read.texts.diff, diffText(asRead(files)));
  for (const f of files) {
    for (const line of (f.patch as string).split("\n")) assert.ok(read.texts.diff.includes(`${line}\n`), line);
  }
  assert.equal(read.texts.instructions, PR_REVIEW_SKILL);
  assert.equal(read.texts.files.trim().split("\n").length, 24);
  const requests = e.gh.calls.length;
  const audited = (await e.sql("SELECT sum(github_requests)::int AS n FROM claw_github_audit WHERE session_id = 's-1'"))[0]?.n;
  assert.equal(audited, requests, "the budget counts what GitHub was asked");
  assert.ok(requests <= e.settings.requestsPerSession, `requests ${requests}`);
  assert.ok(read.calls <= 40, `calls ${read.calls}`);
  // And the review that follows the reading is still within the budget.
  const review = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "Read every page." });
  assert.equal(review.isError, false, review.text.slice(0, 300));
  process.stdout.write(`# G1 measured: ${read.calls} gh_pr_get calls, ${requests} GitHub requests to read, ${e.gh.calls.length} with the review, longest answer ${read.longest} chars, diff ${read.texts.diff.length} chars\n`);
});

test("G2 the review instructions reach the model whole: the default skill, and a repository's skill far longer than one answer", async () => {
  assert.equal((await readSection(e.service, e.actor, PR, "instructions")).text, PR_REVIEW_SKILL);
  const skill = Array.from({ length: 700 }, (_, i) => `- rule ${i}: check "the ${i}th thing" before you approve.`).join("\n");
  e.gh.dirs[".claude/skills"] = [{ name: "review-pr", type: "dir" }];
  e.gh.contents[".claude/skills/review-pr/SKILL.md"] = skill;
  const { text, pages } = await readSection(e.service, e.actor, PR, "instructions");
  assert.ok(text.endsWith(skill), "the last rule of the skill is read");
  assert.match(text, /^The repository's own review skill/);
  assert.ok(pages >= Math.ceil(text.length / PAGE_MAX_CHARS), `pages ${pages}`);
});

test("G3 a page costs one GitHub request (is the head still that one), from this session's read; another session reads for itself", async () => {
  useChange(bigChange(6, 25));
  const first = (await e.service.getPr(e.actor, { pr: PR })).body as any;
  assert.equal(first.sections.diff.inline, false);
  const before = e.gh.calls.length;
  assert.ok(before >= 10, `the overview reads everything: ${before}`);
  const page = await e.service.getPr(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal(page.isError, false);
  assert.deepEqual(e.gh.calls.slice(before).map((c) => c.path), ["/repos/AMD-AGI/demo/pulls/7"]);
  const other = { ...e.actor, sessionId: "s-2" };
  const mark = e.gh.calls.length;
  assert.equal((await e.service.getPr(other, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 })).isError, false);
  assert.ok(e.gh.calls.length - mark >= 10, "another session's page is not served from this session's read");
});

test("G4 a head that moved refuses the page with the new head, and the next overview reads the new head", async () => {
  useChange(bigChange(6, 25));
  await e.service.getPr(e.actor, { pr: PR });
  const moved = "2".repeat(40);
  e.gh.pr.head.sha = moved;
  const page = await e.service.getPr(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal(page.isError, true);
  assert.equal(page.body.reason, "head_moved");
  assert.equal(page.body.current_head_sha, moved);
  e.gh.files = bigChange(1, 3);
  e.gh.pr.changed_files = 1;
  const again = (await e.service.getPr(e.actor, { pr: PR })).body as any;
  assert.equal(again.pull_request.head_sha, moved);
  const diff = (await readSection(e.service, e.actor, PR, "diff")).text;
  assert.equal(diff, diffText(asRead(e.gh.files)), "the new head's diff, not the one read before");
});

test("G5 `file` narrows the diff to one file and `max_diff_chars` makes its pages shorter; each still fits", async () => {
  const files = bigChange(6, 25);
  useChange(files);
  const target = files[3] as FakeFile;
  const { text, pages } = await readSection(e.service, e.actor, PR, "diff", { file: target.filename, max_diff_chars: 1500 });
  assert.equal(text, diffText(asRead([target])));
  assert.ok(pages >= Math.ceil(text.length / 1500), `pages ${pages}`);
  const page = (await e.service.getPr(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0, file: target.filename, max_diff_chars: 1500 })).body as any;
  assert.ok(page.untrusted.text.length <= 1500);
  assert.equal(page.file, target.filename);
});

test("G6 an overview longer than one answer is itself read in pages, and nothing of it is lost", async () => {
  // A base branch that requires 150 checks none of which ran: the overview names each one missing.
  e.gh.rules = [{ type: "required_status_checks", parameters: { required_status_checks: Array.from({ length: 150 }, (_, i) => ({ context: `required-check-with-a-long-name-number-${i}` })) } }];
  e.gh.checkRuns = [];
  const first = await e.service.getPr(e.actor, { pr: PR });
  assert.ok(first.text.length <= PAGE_MAX_CHARS);
  assert.equal(first.body.section, "overview");
  let json = "";
  for (let o: any = first.body; ; ) {
    json += o.text;
    if (o.next_offset === null) break;
    o = (await e.service.getPr(e.actor, { pr: PR, section: "overview", head_sha: HEAD, offset: o.next_offset })).body;
  }
  const overview = JSON.parse(json);
  assert.equal(overview.checks.requiredMissing.length, 150);
  assert.equal(overview.pull_request.head_sha, HEAD);
});

test("G7 a page fits whatever the text costs to escape, ends at a line end when it can, and a line longer than a page is read whole", () => {
  // The overview's way of carrying text, escaped into JSON, which is the costly one to fit.
  const render = (slice: string, next: number | null) => JSON.stringify({ status: "ok", next_offset: next, untrusted: { text: slice } });
  for (const full of [
    "\u0001\"\\\n".repeat(5000),
    `${"x".repeat(20_000)}\nshort\n`,
    "a line\n".repeat(3000),
    `x${"😀".repeat(9000)}`,
    "ab😀c".repeat(4000),
  ]) {
    let got = "";
    for (let offset: number | null = 0; offset !== null;) {
      const page = fitPage(full, offset, 100_000, render);
      assert.ok(page.text.length <= PAGE_MAX_CHARS, `${page.text.length}`);
      const slice = JSON.parse(page.text).untrusted.text as string;
      assert.ok(slice.isWellFormed(), "a page never ends between the two halves of a character");
      if (page.next !== null && full.slice(0, page.next).includes("\n") && full.indexOf("\n", offset) < page.next) {
        if (slice.includes("\n")) assert.ok(slice.endsWith("\n") || slice.length < 50, "a page ends at a line end when it holds one");
      }
      got += slice;
      offset = page.next;
    }
    assert.equal(got, full);
  }
});
