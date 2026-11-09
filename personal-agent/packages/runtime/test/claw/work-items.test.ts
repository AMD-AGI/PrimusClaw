// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawAnswerInvalid, ClawError } from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  item_id: id,
  title: id,
  board_state: "needs_you",
  ...extra,
});

describe("the board", () => {
  it("is the caller's rows, malformed ones skipped, and a state narrows it", async () => {
    const wire = new Wire(() => json(200, { data: [row("a"), { item_id: "" }, "x", row("b")] }));
    const items = await wire.client().workItems.list("ak-a", "needs_you");
    assert.deepEqual(
      items.map((i) => i.itemId),
      ["a", "b"],
    );
    assert.equal(wire.sent[0]?.url.search, "?state=needs_you");
    await wire.client().workItems.list("ak-a");
    assert.equal(wire.sent[1]?.url.search, "");
    wire.answer = () => json(200, { data: {} });
    await assert.rejects(wire.client().workItems.list("ak-a"), ClawAnswerInvalid);
  });

  it("one item, and an answer without one is not understood", async () => {
    const wire = new Wire(() => json(200, { data: row("a") }));
    assert.equal((await wire.client().workItems.get("ak-a", "a")).title, "a");
    wire.answer = () => json(200, { data: { title: "no id" } });
    await assert.rejects(wire.client().workItems.get("ak-a", "a"), ClawAnswerInvalid);
    wire.answer = () => json(404, { ok: false, error: "not_found" });
    await assert.rejects(wire.client().workItems.get("ak-b", "a"), { name: "ClawError", status: 404 });
  });

  it("the reviews asked of others, and none from a Claw without the route", async () => {
    const view = { status: "in_progress", pr_url: "https://github.com/o/r/pull/1" };
    const wire = new Wire(() =>
      json(200, {
        data: [
          { item_id: "r1", reviewer: "  Lin \n Mei ", view },
          { item_id: "r2", reviewer: 5, view },
          { item_id: "", view },
          { item_id: "r3", view: "none" },
        ],
      }),
    );
    const asked = await wire.client().workItems.askedOfOthers("ak-a");
    assert.deepEqual(
      asked.map((a) => [a.itemId, a.reviewer, a.view.status]),
      [
        ["r1", "Lin Mei", "in_progress"],
        ["r2", "", "in_progress"],
      ],
    );
    wire.answer = () => json(404, { ok: false, error: "not_found" });
    assert.deepEqual(await wire.client().workItems.askedOfOthers("ak-a"), []);
    wire.answer = () => json(500, { ok: false });
    await assert.rejects(wire.client().workItems.askedOfOthers("ak-a"), ClawError);
  });

  it("the asker's view of an item", async () => {
    const wire = new Wire(() =>
      json(200, { data: { requester_view: { status: "done", verdict: "approve", merged: true } } }),
    );
    assert.equal((await wire.client().workItems.requesterView("ak-a", "i")).verdict, "approve");
    wire.answer = () => json(200, { data: row("i") });
    await assert.rejects(wire.client().workItems.requesterView("ak-a", "i"), ClawAnswerInvalid);
  });

  it("the pull requests an item made, newest first, each once", async () => {
    const pr = (url: string): Record<string, unknown> => ({ result: { refs: [{ type: "pr", url }] } });
    const wire = new Wire(() =>
      json(200, {
        data: row("i", {
          events: [
            pr("https://github.com/o/r/pull/2"),
            pr("https://github.com/o/r/pull/1"),
            pr("https://github.com/o/r/pull/2"),
            pr("http://github.com/o/r/pull/3"),
            { result: { refs: [{ type: "issue", url: "https://github.com/o/r/pull/4" }] } },
            { result: null },
            "x",
          ],
        }),
      }),
    );
    const { item, pulls } = await wire.client().workItems.pulls("ak-a", "i");
    assert.equal(item.itemId, "i");
    assert.deepEqual(pulls, ["https://github.com/o/r/pull/2", "https://github.com/o/r/pull/1"]);
    wire.answer = () => json(200, { data: { events: [] } });
    await assert.rejects(wire.client().workItems.pulls("ak-a", "i"), ClawAnswerInvalid);
  });
});

describe("deciding an item", () => {
  it("accept says ok with the item, and a 409 says why with the item as it is now", async () => {
    const wire = new Wire(() => json(200, { data: row("i", { result_version: 2 }) }));
    const ok = await wire.client().workItems.accept("ak-a", "i", 2);
    assert.equal(ok.ok, true);
    assert.equal(ok.item.resultVersion, 2);
    assert.deepEqual(wire.sent[0]?.body, { version: 2 });
    wire.answer = () => json(409, { ok: false, error: "version_mismatch", data: row("i", { result_version: 3 }) });
    const refused = await wire.client().workItems.accept("ak-a", "i", 2);
    assert.deepEqual([refused.ok, refused.error, refused.item.resultVersion], [false, "version_mismatch", 3]);
  });

  it("a 409 without the item, or another refusal, is an error, not a decision", async () => {
    const wire = new Wire(() => json(409, { ok: false, error: "item_closed" }));
    await assert.rejects(wire.client().workItems.stop("ak-a", "i"), { name: "ClawError", status: 409 });
    wire.answer = () => new Response("<html>", { status: 409 });
    await assert.rejects(wire.client().workItems.retry("ak-a", "i"), { name: "ClawError", status: 409 });
    wire.answer = () => json(404, { ok: false, error: "not_found" });
    await assert.rejects(wire.client().workItems.retry("ak-a", "i"), { name: "ClawError", status: 404 });
    wire.answer = () => json(200, { data: { title: "x" } });
    await assert.rejects(wire.client().workItems.stop("ak-a", "i"), ClawAnswerInvalid);
    wire.answer = () => json(409, { ok: false, error: 7, data: row("i") });
    assert.equal((await wire.client().workItems.stop("ak-a", "i")).error, "");
  });

  it("the asker of someone else's review is answered with the view alone", async () => {
    const wire = new Wire(() => json(200, { data: { status: "stopped", pr_url: "https://github.com/o/r/pull/1" } }));
    const stopped = await wire.client().workItems.stop("ak-a", "i");
    assert.deepEqual([stopped.ok, stopped.item.boardState, stopped.item.kind], [true, "done", "review"]);
    assert.deepEqual(
      wire.sent.map((s) => s.rawPath),
      ["/v1/work-items/i/stop"],
    );
  });

  it("watching a pull request, and the watches", async () => {
    const wire = new Wire(() => json(200, { data: { sub_id: 5 } }));
    const claw = wire.client();
    assert.deepEqual(await claw.workItems.watchPull("tok", "i", "https://github.com/o/r/pull/1"), { sub_id: 5 });
    assert.deepEqual(wire.sent[0]?.body, { pr: "https://github.com/o/r/pull/1", reply: true });
    await claw.workItems.watchPull("tok", "i", "u", false);
    assert.deepEqual(wire.sent[1]?.body, { pr: "u", reply: false });
    assert.deepEqual(await claw.workItems.unwatchPull("ak-a", "i", "5"), { sub_id: 5 });
    wire.answer = () => json(200, { data: [{ sub_id: 1 }, "x"] });
    assert.deepEqual(await claw.workItems.watches("ak-a", "i"), [{ sub_id: 1 }]);
    wire.answer = () => json(200, { data: null });
    assert.deepEqual(await claw.workItems.watches("ak-a", "i"), []);
  });
});
