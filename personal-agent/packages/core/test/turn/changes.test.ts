// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session changed (contract C3), as the turn reads it and offers it under a finished answer
 * (test_changes_card.py, the parts that are not the card's JSON): what is parsed of Claw's reply, that every failure to get
 * it leaves the answer alone, and that the changes view follows a finished answer.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawAnswerInvalid, ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import type { OutMessage } from "../../src/ports/surface.js";
import {
  type Changes,
  fetchChanges,
  parseChanges,
  repoName,
  totalAdditions,
  totalDeletions,
  totalFiles,
} from "../../src/turn/changes.js";
import { play, type Run } from "./play.js";
import { Timeline } from "./timeline.js";
import { ev, RecordingLogger, result, ScriptedClaw, textOf } from "./world.js";

type Raw = Record<string, unknown>;

function f(path: unknown, status = "M", additions: unknown = 1, deletions: unknown = 0, binary: unknown = false): Raw {
  return { path, status, additions, deletions, binary };
}

function repo(
  files: unknown[],
  options: { path?: string; branch?: string; head?: string; truncated?: boolean; totals?: Raw } = {},
): Raw {
  const counted = files.filter((x): x is Raw => typeof x === "object" && x !== null && !Array.isArray(x));
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    path: options.path ?? "/workspace/app",
    branch: options.branch ?? "feat/x",
    head: options.head ?? "a1b2c3d",
    truncated: options.truncated ?? false,
    totals: options.totals ?? {
      files: files.length,
      additions: counted.reduce((n, x) => n + num(x["additions"]), 0),
      deletions: counted.reduce((n, x) => n + num(x["deletions"]), 0),
    },
    files,
  };
}

function reply(repos: unknown[], truncated = false): Raw {
  return { ok: true, session_id: "s1", generated_at: "2026-10-29T08:00:00Z", truncated, repos };
}

function files(n: number, prefix = "f"): Raw[] {
  return Array.from({ length: n }, (_, i) => f(`${prefix}${String(i)}.py`, "M", i + 1, 0));
}

const MIXED = reply([
  repo([
    f("src/app.py", "M", 12, 3),
    f("src/new.py", "A", 40, 0),
    f("old.txt", "D", 0, 9),
    f("a.py -> b.py", "R", 2, 2),
    f("notes.md", "?", 5, 0),
  ]),
]);

function parsed(payload: unknown): Changes {
  const changes = parseChanges(payload);
  assert.ok(changes !== undefined);
  return changes;
}

// --- what is parsed ---------------------------------------------------------------------------------------------------

it("test_what_is_not_a_changes_reply_or_has_no_changes_shows_nothing", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", ["repos"]],
    ["nothing", null],
    ["a string", "ok"],
    ["not ok", { ...reply([repo([f("a.py")])]), ok: false }],
    ["ok is a string", { ...reply([repo([f("a.py")])]), ok: "true" }],
    ["no repos key", { ok: true }],
    ["repos is not a list", { ok: true, repos: { a: 1 } }],
    ["no repositories", reply([])],
    ["a repository with no files", reply([repo([])])],
    ["files is not a list", reply([{ path: "/w/a", files: "a.py", totals: { files: 1 } }])],
    [
      "only items that are not files",
      reply([repo(["a.py", 3, null, { status: "M" }, { path: "" }, { path: 7 }], { totals: { files: 0 } })]),
    ],
    ["a repository that is not an object", reply(["app", 5, null])],
  ];
  for (const [name, payload] of cases) assert.equal(parseChanges(payload), undefined, name);
});

it("test_a_binary_file_has_no_counts_even_when_claw_sends_some", () => {
  const binary = parsed(reply([repo([f("logo.png", "M", 5, 7, true)])])).repos[0]?.files;
  assert.equal(binary?.length, 1);
  assert.deepEqual([binary[0]?.binary, binary[0]?.additions, binary[0]?.deletions], [true, undefined, undefined]);
  const text = parsed(reply([repo([f("a.py", "M", 5, 7, false)])])).repos[0]?.files;
  assert.equal(text?.length, 1);
  assert.deepEqual([text[0]?.binary, text[0]?.additions, text[0]?.deletions], [false, 5, 7]);
});

it("test_an_odd_file_never_hides_the_rest", () => {
  const changes = parsed(
    reply([
      repo(
        [
          f("a.py"),
          "junk",
          null,
          { path: "b.py", status: "A", additions: -1, deletions: "3", binary: "yes" },
          { path: "c.py", additions: true },
          f("d.py"),
        ],
        { totals: { files: 4, additions: 2, deletions: 0 } },
      ),
    ]),
  );
  assert.deepEqual(
    changes.repos[0]?.files.map((x) => [x.path, x.status, x.additions, x.deletions, x.binary]),
    [
      ["a.py", "M", 1, 0, false],
      ["b.py", "A", undefined, undefined, false],
      ["c.py", "?", undefined, undefined, false],
      ["d.py", "M", 1, 0, false],
    ],
  );
});

it("test_text_from_claw_is_one_clipped_line", () => {
  const repos = parsed(
    reply([repo([f(`${"x".repeat(500)}\n  y`)], { branch: "b".repeat(300), head: "h".repeat(40) })]),
  ).repos;
  assert.equal(repos.length, 1);
  const item = repos[0];
  assert.ok(item !== undefined);
  const path = item.files[0]?.path ?? "";
  assert.ok(path.length === 300 && !path.includes("\n") && item.branch?.length === 100 && item.head.length === 12);
});

it("test_line_breaks_and_runs_of_spaces_in_claws_text_become_single_spaces", () => {
  const repos = parsed(reply([repo([f("dir/\nweird   name\t.py")], { branch: "feat/x\r\ny", head: "a1\nb2" })])).repos;
  assert.equal(repos.length, 1);
  const item = repos[0];
  assert.deepEqual([item?.files[0]?.path, item?.branch, item?.head], ["dir/ weird name .py", "feat/x y", "a1 b2"]);
});

it("test_it_reads_at_most_what_a_person_looks_at", () => {
  const many = reply(
    Array.from({ length: 60 }, (_, n) => repo([f(`r${String(n)}.py`)], { path: `/workspace/r${String(n)}` })),
  );
  assert.equal(parsed(many).repos.length, 20);
  assert.equal(parsed(reply([repo(files(900))])).repos[0]?.files.length, 500);
});

it("test_the_totals_add_up_over_repositories", () => {
  const changes = parsed(
    reply([
      repo(files(3)),
      repo(files(2), { path: "/workspace/lib", totals: { files: 9, additions: 100, deletions: 7 } }),
    ]),
  );
  assert.deepEqual([totalFiles(changes), totalAdditions(changes), totalDeletions(changes)], [12, 106, 7]);
  assert.deepEqual(changes.repos.map(repoName), ["app", "lib"]);
});

// --- failing to get it: nothing is shown, nothing is raised ----------------------------------------------------------

function clawAnswering(answer: unknown): ScriptedClaw {
  const claw = new ScriptedClaw(new Timeline());
  claw.changesReply = answer;
  return claw;
}

it("test_a_failure_to_read_the_changes_shows_no_changes", async () => {
  for (const failure of [
    new ClawError(409, '{"ok":false,"error":"sandbox_not_running"}'),
    new ClawError(404, "not found"),
    new ClawError(401, "no"),
    new ClawError(500, "boom"),
    new ClawError(503, ""),
    new ClawUnreachable("timeout", "read"),
    new ClawUnreachable("timeout", "connect"),
    new ClawUnreachable("network", "connect"),
    new ClawUnreachable("network", "cut"),
    new ClawAnswerInvalid("not json"),
  ]) {
    const claw = clawAnswering(failure);
    assert.equal(await fetchChanges(claw, "ak-a", "s1", new RecordingLogger()), undefined, failure.message);
    assert.deepEqual(claw.calls, [["changes", "ak-a", "s1", 5000]]);
  }
});

it("test_the_calls_that_are_expected_are_not_warnings_and_the_others_are", async () => {
  const log = new RecordingLogger();
  for (const failure of [new ClawError(409), new ClawError(404)])
    await fetchChanges(clawAnswering(failure), "ak-a", "s1", log);
  assert.ok(!log.lines.some((l) => l.level === "warn" || l.level === "error"));
  await fetchChanges(clawAnswering(new ClawError(500)), "ak-a", "s1", log);
  await fetchChanges(clawAnswering(new ClawUnreachable("timeout", "read")), "ak-a", "s1", log);
  assert.equal(log.lines.filter((l) => l.level === "warn").length, 2);
});

it("test_a_good_reply_is_the_changes_and_a_reply_with_nothing_changed_is_none", async () => {
  const good = await fetchChanges(clawAnswering(MIXED), "ak-a", "s1", new RecordingLogger());
  assert.ok(good !== undefined);
  assert.equal(totalFiles(good), 5);
  assert.equal(await fetchChanges(clawAnswering(reply([repo([])])), "ak-a", "s1", new RecordingLogger()), undefined);
});

// --- under a finished answer -------------------------------------------------------------------------------------------

const SESSION = "sess-ak";

interface ChangesView {
  readonly at: number;
  readonly changes: Changes;
  readonly sessionId: string;
}

function changesViews(run: Run): ChangesView[] {
  return run.bus.sent.flatMap((s, at) => {
    const body: OutMessage["body"] | undefined = s.message?.body;
    if (s.operation !== "send" || body?.type !== "view" || body.view.name !== "changes") return [];
    return [{ at, changes: body.view.model.changes, sessionId: body.view.model.sessionId }];
  });
}

function changesCalls(run: Run): unknown[][] {
  return run.claw.calls.filter((c) => c[0] === "changes");
}

async function finished(answer: unknown, events = [[0.5, result("Fixed the build.")] as const]): Promise<Run> {
  return play(events, {
    request: { showChanges: true },
    setUp: (w) => {
      w.claw.changesReply = answer;
    },
  });
}

it("test_a_finished_answer_is_followed_by_the_changes_card", async () => {
  const run = await finished(MIXED);
  const views = changesViews(run);
  assert.equal(views.length, 1);
  const view = views[0];
  assert.ok(view !== undefined);
  assert.deepEqual([totalFiles(view.changes), totalAdditions(view.changes), totalDeletions(view.changes)], [5, 59, 14]);
  assert.equal(view.sessionId, SESSION);
  const answered = Math.max(
    ...run.bus.sent.flatMap((s, i) => (textOf(s.message).includes("Fixed the build.") ? [i] : [])),
  );
  assert.ok(view.at > answered); // after the answer
  assert.deepEqual(
    changesCalls(run).map((c) => c.slice(0, 3)),
    [["changes", "ak", SESSION]],
  ); // with the user's own key
});

it("test_whatever_goes_wrong_with_the_changes_the_answer_is_there_and_nothing_else_is", async () => {
  for (const failure of [
    undefined, // 409: the sandbox is gone
    new ClawError(404),
    new ClawError(500),
    new ClawUnreachable("timeout", "read"),
    new ClawAnswerInvalid("no json"),
    new Error("anything at all"),
  ]) {
    const run = await finished(failure);
    const name = failure?.message ?? "409";
    assert.deepEqual(changesViews(run), [], name);
    assert.ok(
      run.texts.some((t) => t.includes("Fixed the build.")),
      name,
    );
    assert.ok(changesCalls(run).length === 1 && !run.texts.join(" ").includes("went wrong"), name);
    assert.ok(!run.bus.everything().includes("Report a problem"), name);
  }
});

it("test_a_session_that_changed_nothing_shows_no_card", async () => {
  const run = await finished(reply([repo([])]), [[0.5, result("Nothing to change.")]]);
  assert.ok(changesViews(run).length === 0 && changesCalls(run).length === 1);
});

it("test_a_turn_that_did_not_finish_well_shows_no_card_and_asks_nothing", async () => {
  const run = await finished(MIXED, [
    [0.5, ev("ResultMessage", "m1", { final_text: "partial", data: { subtype: "error" } })],
  ]);
  assert.ok(changesViews(run).length === 0 && changesCalls(run).length === 0);
});

it("test_a_slow_sandbox_does_not_hold_the_answer_or_the_chat", async () => {
  let release: (value: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = await play([[0.5, result("Fixed the build.")]], {
    request: { showChanges: true },
    setUp: (w) => {
      w.claw.changes = (key: string, sessionId: string, timeoutMs: number): Promise<unknown> => {
        w.claw.calls.push(["changes", key, sessionId, timeoutMs]);
        return gate.then(() => MIXED);
      };
    },
  });
  // the answer is in, the turn is over for the chat, the card is not yet
  assert.ok(run.texts.some((t) => t.includes("Fixed the build.")) && changesViews(run).length === 0);
  release(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(changesViews(run).length, 1);
});
