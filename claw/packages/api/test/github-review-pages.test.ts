// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `gh_pr_get` in pages: a model whose every tool result is cut past 6000 characters (Brain's `TOOL_RESULT_MAX_CHARS`) still reads the
 * whole change and the whole review instructions, within the session's GitHub request budget.
 *
 *   G1  a pull request of about 1800 changed lines, read the way the tool tells the model to: every answer fits, every hunk is read, and
 *       the calls and the GitHub requests stay within the budget
 *   G2  the review instructions reach the model whole, the default ones and a repository's long skill
 *   G3  a page costs one GitHub request (repository gates and head), from what the session read of that head; another session reads for itself
 *   G4  a head that moved refuses the page, and the next overview reads the new head
 *   G5  `file` and `max_diff_chars` narrow a page, which still fits
 *   G6  an overview too long for one answer is itself read in pages, and still names the sections to read
 *   G7  a page fits whatever the text costs to escape, and a line longer than a page is still read whole
 *   G8  a page from the session's read is still held to the repository gates as they are now
 *   G9  the acting user's token is masked in a section before it is cut into pages, so no two pages put it back together
 *   G10 an offset past the end of a section, or outside the named file, is refused: never an empty page that reads as the end
 *   G11 a file that is not in the change is refused, not answered with an empty diff
 *   G13 a pull request retargeted to another base branch, same head, refuses the page: the diff read is no longer the change
 *   G14 a page is served only from a read that says what the overview's read said (read_id): a base branch that moved, or a read lost
 *       from memory, is read again and refused when the change no longer reads the same
 *   G12 `file` with the offset the files index gives reads that file's part whole, in the whole diff's offsets
 */
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { DEEP_PR_REVIEW_INSTRUCTIONS } from "../src/github-review/default-skill.js";
import { PAGE_MAX_CHARS, diffText, fitPage } from "../src/github-review/pages.js";
import { languageChecksText } from "../src/github-review/review-rules.js";
import type { RiskFile } from "../src/github-review/risk.js";
import { BASE_TIP, HEAD, type FakeFile } from "./support/fake-github.js";
import { PR, TOKEN, closeShared, readSection, reviewEnv, type ReviewEnv } from "./support/review-env.js";

/** Brain's cut (brain/src/agent/agent-loop.ts): a longer result reaches the model with its middle missing. */
const BRAIN_CUT = 24_000;

let e: ReviewEnv;
/** The read_id of the last overview: a page continues it, as the model is told to pass it. */
let lastReadId = "";
/** `gh_pr_get` as the model calls it: a page carries the read_id of the last overview unless the test names one. */
async function gp(actor: ReviewEnv["actor"], args: Record<string, unknown>) {
  const o = await e.service.getPr(actor, args.head_sha !== undefined && args.read_id === undefined ? { ...args, read_id: lastReadId } : args);
  if (args.head_sha === undefined && typeof o.body.read_id === "string") lastReadId = o.body.read_id;
  return o;
}
beforeEach(async () => { e = await reviewEnv(); });
afterEach(async () => { await e.close(); });
after(closeShared);

/** `files` files of three hunks each; every changed line is unique and full of what JSON escapes. */
/** The deep instructions as the review reads them for these changed files: the default ones and the checks for their languages. */
function deepInstructions(files: readonly FakeFile[]): string {
  const checks = languageChecksText(files.map((f) => f.filename));
  return checks ? `${DEEP_PR_REVIEW_INSTRUCTIONS.trimEnd()}\n\n${checks}\n` : DEEP_PR_REVIEW_INSTRUCTIONS;
}

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
    const o = await gp(e.actor, { pr: PR, ...args });
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
      const text = await call({ section, head_sha: overview.pull_request.head_sha, read_id: overview.read_id, offset });
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
  assert.equal(read.texts.instructions, deepInstructions(files));
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
  assert.equal((await readSection(e.service, e.actor, PR, "instructions")).text, deepInstructions(e.gh.files));
  const skill = Array.from({ length: 700 }, (_, i) => `- rule ${i}: check "the ${i}th thing" before you approve.`).join("\n");
  e.gh.dirs[".claude/skills"] = [{ name: "review-pr", type: "dir" }];
  e.gh.contents[".claude/skills/review-pr/SKILL.md"] = skill;
  const { text, pages } = await readSection(e.service, e.actor, PR, "instructions");
  // The checks for the changed files' languages follow the repository's own instructions, which reach the model whole before them.
  assert.ok(text.includes(`${skill}\n`), "the last rule of the skill is read");
  assert.ok(text.endsWith(`${languageChecksText(e.gh.files.map((f) => f.filename))}\n`), "then the language checks");
  assert.match(text, /^The repository's own review instructions/);
  assert.ok(pages >= Math.ceil(text.length / PAGE_MAX_CHARS), `pages ${pages}`);
});

test("G3 a page costs one GitHub request (the repository gates and the head, as they are now), from this session's read; another session reads for itself", async () => {
  useChange(bigChange(6, 25));
  const first = (await gp(e.actor, { pr: PR })).body as any;
  assert.equal(first.sections.diff.inline, false);
  const before = e.gh.calls.length;
  assert.ok(before >= 10, `the overview reads everything: ${before}`);
  const page = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal(page.isError, false);
  assert.deepEqual(e.gh.calls.slice(before).map((c) => c.path), ["/graphql"]);
  const other = { ...e.actor, sessionId: "s-2" };
  const mark = e.gh.calls.length;
  assert.equal((await gp(other, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 })).isError, false);
  assert.ok(e.gh.calls.length - mark >= 10, "another session's page is not served from this session's read");
});

test("G4 a head that moved refuses the page with the new head, and the next overview reads the new head", async () => {
  useChange(bigChange(6, 25));
  await gp(e.actor, { pr: PR });
  const moved = "2".repeat(40);
  e.gh.pr.head.sha = moved;
  const page = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal(page.isError, true);
  assert.equal(page.body.reason, "head_moved");
  assert.equal(page.body.current_head_sha, moved);
  e.gh.files = bigChange(1, 3);
  e.gh.pr.changed_files = 1;
  const again = (await gp(e.actor, { pr: PR })).body as any;
  assert.equal(again.pull_request.head_sha, moved);
  const diff = (await readSection(e.service, e.actor, PR, "diff")).text;
  assert.equal(diff, diffText(asRead(e.gh.files)), "the new head's diff, not the one read before");
});

test("G5 `file` narrows the diff to one file and `max_diff_chars` makes its pages shorter; each still fits", async () => {
  // Each file longer than one answer, so that its diff is read in pages and never inline.
  const files = bigChange(6, 120);
  useChange(files);
  const target = files[3] as FakeFile;
  const { text, pages } = await readSection(e.service, e.actor, PR, "diff", { file: target.filename, max_diff_chars: 1500 });
  assert.equal(text, diffText(asRead([target])));
  assert.ok(pages >= Math.ceil(text.length / 1500), `pages ${pages}`);
  await gp(e.actor, { pr: PR });
  const page = (await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0, file: target.filename, max_diff_chars: 1500 })).body as any;
  assert.ok(page.untrusted.text.length <= 1500);
  assert.equal(page.file, target.filename);
});

test("G6 an overview longer than one answer is itself read in pages, and nothing of it is lost", async () => {
  // A base branch that requires 150 checks none of which ran: the overview names each one missing.
  e.gh.rules = [{ type: "required_status_checks", parameters: { required_status_checks: Array.from({ length: 150 }, (_, i) => ({ context: `required-check-with-a-long-name-number-${i}` })) } }];
  e.gh.checkRuns = [];
  const first = await gp(e.actor, { pr: PR });
  assert.ok(first.text.length <= PAGE_MAX_CHARS);
  assert.equal(first.body.section, "overview");
  let json = "";
  for (let o: any = first.body; ; ) {
    json += o.text;
    if (o.next_offset === null) break;
    o = (await gp(e.actor, { pr: PR, section: "overview", head_sha: HEAD, offset: o.next_offset })).body;
  }
  const overview = JSON.parse(json);
  assert.equal(overview.checks.requiredMissing.length, 150);
  assert.equal(overview.pull_request.head_sha, HEAD);
  // It still says what else there is to read, and how: none of it is inline, and the instructions are read from it.
  assert.equal(overview.how_to_read.length > 0, true);
  assert.deepEqual(Object.keys(overview.sections).sort(), ["conversation", "diff", "files", "instructions"]);
  assert.ok(Object.values(overview.sections).every((s: any) => s.inline === false));
  assert.equal((await readSection(e.service, e.actor, PR, "instructions")).text, deepInstructions(e.gh.files));
});

test("G8 a page from the session's read is still held to the repository as it is now: owner, public, not archived", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["repository_not_public", { private: true, visibility: "private" }],
    ["repository_not_public", { visibility: "internal" }],
    ["repository_archived", { archived: true }],
    ["repository_archived", { disabled: true }],
    ["owner_not_allowed", { owner: { login: "someone-else" } }],
  ];
  for (const [code, patch] of cases) {
    e = await reviewEnv(); // a request budget of its own for each case
    useChange(bigChange(6, 25));
    const original = { ...e.gh.repo };
    assert.equal((await gp(e.actor, { pr: PR })).isError, false);
    e.gh.repo = { ...original, ...patch };
    const page = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
    assert.equal(page.isError, true, JSON.stringify(patch));
    assert.equal(page.body.reason, code, JSON.stringify(patch));
    assert.equal(page.body.untrusted, undefined);
  }
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
  // A page of one character asked for, starting at a character outside the basic plane: both halves come together.
  const astral = "x😀y😀😀z";
  let got = "";
  for (let offset: number | null = 0; offset !== null;) {
    const page = fitPage(astral, offset, 1, render);
    const slice = JSON.parse(page.text).untrusted.text as string;
    assert.ok(slice.isWellFormed(), `at ${offset}`);
    got += slice;
    offset = page.next;
  }
  assert.equal(got, astral);
});

test("G9 the acting user's token in the change is masked before the section is cut into pages: no page boundary splits it out of reach", async () => {
  // One line far longer than a page, the token every 97 characters: page boundaries fall inside some of them.
  const line = Array.from({ length: Math.ceil(PAGE_MAX_CHARS * 8 / 97) }, (_, i) => `${"x".repeat(i % 50)}${TOKEN}`.padEnd(97, "y")).join("");
  useChange([{ filename: "leak.ts", status: "added", additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${line}` }]);
  for (const section of ["diff", "files"]) {
    const { text, pages } = await readSection(e.service, e.actor, PR, section);
    if (section === "diff") assert.ok(pages > 5, `pages ${pages}`);
    assert.ok(!text.includes(TOKEN), `${section}: the pages put together carry the token`);
    for (let n = 12; n < TOKEN.length; n += 6) assert.ok(!text.includes(TOKEN.slice(0, n)), `${section}: a prefix of ${n}`);
  }
});

const refusal = (o: { isError: boolean; body: Record<string, unknown> }) => (o.isError ? String(o.body.reason) : "answered");

test("G10 an offset past the end of a section, or outside the named file, is refused with the section's length: never an empty page that reads as the end", async () => {
  e = await reviewEnv({ CLAW_GITHUB_REQUESTS_PER_SESSION: "1000" }); // many whole reads; the budget is G1's subject
  const files = bigChange(6, 25);
  useChange(files);
  await gp(e.actor, { pr: PR });
  for (const section of ["diff", "files", "instructions", "conversation"]) {
    const { text } = await readSection(e.service, e.actor, PR, section);
    for (const offset of [text.length, text.length + 1, text.length + 50_000]) {
      const o = await gp(e.actor, { pr: PR, section, head_sha: HEAD, offset });
      assert.equal(refusal(o), "offset_out_of_range", `${section} at ${offset}`);
      assert.equal(o.body.section_chars, text.length, section);
    }
    const last = await gp(e.actor, { pr: PR, section, head_sha: HEAD, offset: text.length - 1 });
    assert.equal(refusal(last), "answered", `${section}: the last character is still a page`);
  }
  // Inside the diff but outside the named file: before it and at its end.
  const [first, fourth] = [files[0] as FakeFile, files[3] as FakeFile];
  const ranges = (await readSection(e.service, e.actor, PR, "files")).text.trim().split("\n").map((l) => /diff offset (\d+), (\d+) chars/.exec(l) as RegExpExecArray);
  const r4 = { start: Number(ranges[3]?.[1]), end: Number(ranges[3]?.[1]) + Number(ranges[3]?.[2]) };
  for (const offset of [r4.start - 1, r4.end, r4.end + 10]) {
    const o = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset, file: fourth.filename });
    assert.equal(refusal(o), "offset_out_of_range", `${offset}`);
    assert.deepEqual([o.body.file_start, o.body.file_end], [r4.start, r4.end]);
  }
  assert.equal(refusal(await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0, file: first.filename })), "answered");
});

test("G11 a file that is not in the change is refused, in the overview and in a page, not answered with an empty diff", async () => {
  useChange(bigChange(6, 25));
  assert.equal(refusal(await gp(e.actor, { pr: PR, file: "src/nope.ts" })), "unknown_file");
  assert.equal(refusal(await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0, file: "src/nope.ts" })), "unknown_file");
});

test("G12 `file` with the offset the files index gives reads that file's part whole, and its pages go on in the whole diff's offsets", async () => {
  e = await reviewEnv({ CLAW_GITHUB_REQUESTS_PER_SESSION: "1000" }); // many whole reads; the budget is G1's subject
  const files = bigChange(6, 25);
  useChange(files);
  await gp(e.actor, { pr: PR });
  const index = (await readSection(e.service, e.actor, PR, "files")).text.trim().split("\n");
  const whole = diffText(asRead(files));
  for (const [i, f] of files.entries()) {
    const m = /diff offset (\d+), (\d+) chars/.exec(index[i] as string) as RegExpExecArray;
    const start = Number(m[1]);
    let text = "";
    let pages = 0;
    for (let offset: number | null = start; offset !== null; pages++) {
      const o = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset, file: f.filename, max_diff_chars: 2000 });
      assert.equal(o.isError, false, o.text.slice(0, 200));
      const b = o.body as any;
      assert.equal(b.offset, offset);
      text += b.untrusted.text;
      offset = b.next_offset;
      if (offset !== null) assert.equal(whole.slice(start, offset), text, "a next offset is the whole diff's");
    }
    assert.equal(text, diffText(asRead([f])), f.filename);
    assert.equal(text.length, Number(m[2]));
    assert.ok(pages > 1, `pages ${pages}`);
  }
});

test("G13 a pull request retargeted to another base branch with the same head refuses the page, and the next overview reads the new diff", async () => {
  useChange(bigChange(6, 25));
  await gp(e.actor, { pr: PR });
  e.gh.pr.base = { ...e.gh.pr.base, ref: "release-1" };
  e.gh.files = bigChange(2, 3);
  e.gh.pr.changed_files = 2;
  const page = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal(page.isError, true);
  assert.equal(page.body.reason, "base_changed");
  assert.equal(page.body.current_base, "release-1");
  assert.equal(page.body.untrusted, undefined);
  const again = (await gp(e.actor, { pr: PR })).body as any;
  assert.equal(again.pull_request.base, "release-1");
  const fresh = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal((fresh.body as any).untrusted.text, diffText(asRead(e.gh.files)));
});

test("G14 a page is served only from a read that says what the overview's read said: a moved base or a forgotten read is read again, and refused when the change differs", async () => {
  e = await reviewEnv({ CLAW_GITHUB_REQUESTS_PER_SESSION: "1000" });
  const files = bigChange(6, 25);
  useChange(files);
  const first = (await gp(e.actor, { pr: PR })).body as any;
  assert.match(first.read_id, /^[0-9a-f]{16}$/);
  assert.equal(refusal(await e.service.getPr(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 })), "read_id_required");
  // The base branch moves on, and the diff stays the same: the page is served, from a new read.
  e.gh.pr.base = { ...e.gh.pr.base, sha: "c".repeat(40) };
  const same = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 0 });
  assert.equal(refusal(same), "answered");
  assert.equal(same.body.read_id, first.read_id);
  // It moves again, and the merge base with it: the diff is another one, and the page is refused.
  e.gh.pr.base = { ...e.gh.pr.base, sha: "d".repeat(40) };
  e.gh.files = [...files.slice(0, 5), { ...(files[5] as FakeFile), patch: `${(files[5] as FakeFile).patch}\n+  one more line` }];
  const moved = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, offset: 5000 });
  assert.equal(refusal(moved), "read_changed");
  assert.notEqual(moved.body.current_read_id, first.read_id);
  assert.equal(moved.body.untrusted, undefined);
  // A read forgotten (more sessions than are kept), then the change differs with the same head and base: refused, not paged on.
  e.gh.files = files;
  e.gh.pr.base = { ...e.gh.pr.base, sha: BASE_TIP };
  const again = (await gp(e.actor, { pr: PR })).body as any;
  assert.equal(again.read_id, first.read_id);
  for (let i = 0; i < 70; i++) await e.service.getPr({ ...e.actor, sessionId: `s-other-${i}` }, { pr: PR });
  e.gh.files = bigChange(5, 25);
  const forgotten = await gp(e.actor, { pr: PR, section: "diff", head_sha: HEAD, read_id: again.read_id, offset: 5000 });
  assert.equal(refusal(forgotten), "read_changed");
});
