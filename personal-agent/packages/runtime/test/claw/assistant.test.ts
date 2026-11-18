// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClawAnswerInvalid,
  ClawError,
  CredentialMisuse,
  ReviewsRefused,
  type StartReviews,
} from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

const request: StartReviews = {
  modelKey: "ak-own",
  prs: [
    { pull: { owner: "o", repo: "r", number: 1 }, message: "" },
    { pull: { owner: "o", repo: "r", number: 2 }, message: "look at the tests" },
  ],
  actingAs: "u-1",
  actingAsName: "Lin Mei",
  reviewOnly: false,
  model: "",
};
const started = {
  data: { items: [{ pr: { owner: "o", repo: "r", number: 1 }, item_id: "i1", session_id: "s1", review_only: false }] },
};

describe("the assistant", () => {
  it("its session, made on first use", async () => {
    const wire = new Wire(() => json(200, { data: { session_id: "asst-1", created: true } }));
    assert.deepEqual(await wire.client().assistant.session("ak-a"), { sessionId: "asst-1", created: true });
    assert.deepEqual(wire.sent[0]?.body, {});
    wire.answer = () => json(200, { data: { session_id: 0 } });
    assert.deepEqual(await wire.client().assistant.session("ak-a"), { sessionId: "0", created: false });
    wire.answer = () => json(200, { data: {} });
    await assert.rejects(wire.client().assistant.session("ak-a"), ClawAnswerInvalid);
    wire.answer = () => json(404, { ok: false, error: "not_found" });
    await assert.rejects(wire.client().assistant.session("ak-a"), { name: "ClawError", status: 404 });
  });

  it("a message goes as typed with a short timeout, with its context and plugin", async () => {
    const wire = new Wire(() => json(200, { ok: true, message_id: "m-1" }));
    const claw = wire.client({ ruleToolId: 17, pluginId: 2 });
    assert.equal(await claw.assistant.send("ak-a", "asst", "hello"), "m-1");
    assert.deepEqual(wire.sent[0]?.body, { content: "hello", messageType: "text" });
    await claw.assistant.send("tok", "asst", "hi", { context: { chat: "dm" }, plugin: 2, modelKey: "ak-own" });
    assert.deepEqual(wire.sent[1]?.body, {
      content: "hi",
      messageType: "text",
      channel_context: { chat: "dm" },
      pluginId: 2,
    });
    assert.equal(wire.sent.at(1)?.headers.get("x-api-key") ?? null, "ak-own");
    await claw.assistant.send("ak-a", "asst", "x", { context: {} });
    assert.deepEqual(wire.sent[2]?.body, { content: "x", messageType: "text" });
    wire.answer = () => json(200, { ok: true, queued: true });
    assert.equal(await claw.assistant.send("ak-a", "asst", "and then"), null);
  });

  it("the brief, a held write's answer, and observing", async () => {
    const wire = new Wire(() => json(200, { data: { text: "brief" } }));
    const claw = wire.client();
    assert.deepEqual(await claw.assistant.brief("ak-a", "zh", "Asia/Shanghai"), { text: "brief" });
    assert.equal(wire.sent[0]?.url.search, "?lang=zh&timezone=Asia%2FShanghai");
    assert.deepEqual(await claw.assistant.decideConfirmation("tok", "cf1", "allow"), { text: "brief" });
    wire.answer = () => json(200, { status: "done" });
    assert.deepEqual(await claw.assistant.decideConfirmation("tok", "cf1", "deny"), { status: "done" });
    await assert.rejects(claw.assistant.decideConfirmation("ak-a", "cf1", "allow"), CredentialMisuse);
    wire.answer = () => json(200, { data: { mode: "observe" } });
    assert.deepEqual(await claw.assistant.observeScope("ak-a", "group:x"), { mode: "observe" });
    assert.deepEqual(wire.sent.at(-1)?.body, { scope: "group:x", mode: "observe" });
    await claw.assistant.observe("ak-a", "group:x", "Alice: hi", "m1");
    assert.deepEqual(wire.sent.at(-1)?.body, { scope: "group:x", content: "Alice: hi", message_id: "m1" });
  });

  it("what a watcher would have done, none for a scope never watched", async () => {
    const wire = new Wire(() => json(200, { data: [{ id: 1 }, 2] }));
    const claw = wire.client();
    assert.deepEqual(await claw.assistant.observations("ak-a", "group:teams:19:c@thread.v2"), [{ id: 1 }]);
    assert.equal(wire.sent[0]?.url.search, "?scope=group%3Ateams%3A19%3Ac%40thread.v2&limit=20");
    wire.answer = () => json(404, { ok: false });
    assert.deepEqual(await claw.assistant.observations("ak-a", "s", 5), []);
    wire.answer = () => json(500, { ok: false });
    await assert.rejects(claw.assistant.observations("ak-a", "s"), ClawError);
    wire.answer = () => json(200, { data: {} });
    await assert.rejects(claw.assistant.observations("ak-a", "s"), ClawAnswerInvalid);
  });
});

describe("starting reviews", () => {
  it("as the requester: the token, the model key, and every pull request", async () => {
    const wire = new Wire(() => json(200, started));
    const [review] = await wire.client().assistant.startReviews("tok", { ...request, model: "m" });
    assert.equal(review?.sessionId, "s1");
    const [sent] = wire.sent;
    assert.ok(sent);
    assert.equal(sent.headers.get("authorization"), "Bearer tok");
    assert.equal(sent.headers.get("x-api-key"), "ak-own");
    assert.deepEqual(sent.body, {
      prs: [
        { owner: "o", repo: "r", number: 1 },
        { owner: "o", repo: "r", number: 2, message: "look at the tests" },
      ],
      acting_as: "u-1",
      review_only: false,
      acting_as_name: "Lin Mei",
      model: "m",
    });
  });

  it("asked of someone else: their token and key, the asker's note, and no session to follow", async () => {
    const wire = new Wire(() =>
      json(200, { data: { items: [{ pr: { owner: "o", repo: "r", number: 1 }, item_id: "i1", review_only: false }] } }),
    );
    const [review] = await wire.client().assistant.startReviews("tok", {
      ...request,
      actingToken: "their-token",
      actingKey: "ak-theirs",
      requesterNote: "  please check the tests  ",
      handoffId: "h1",
    });
    assert.equal(review?.sessionId, "");
    const [sent] = wire.sent;
    assert.ok(sent);
    assert.equal(sent.headers.get("x-acting-as-token"), "their-token");
    assert.equal(sent.headers.get("x-acting-as-api-key"), "ak-theirs");
    assert.equal(sent.headers.get("x-api-key"), null);
    const body = sent.body as Record<string, unknown>;
    assert.equal(body["requester_note"], "please check the tests");
    assert.equal(body["handoff_id"], "h1");
  });
});

describe("starting reviews, refused", () => {
  it("wrong credentials are refused before anything is sent", async () => {
    const wire = new Wire(() => json(200, started));
    const claw = wire.client();
    await assert.rejects(claw.assistant.startReviews("ak-a", request), CredentialMisuse);
    await assert.rejects(
      claw.assistant.startReviews("tok", { ...request, actingToken: "ak-x", actingKey: "ak-y" }),
      CredentialMisuse,
    );
    await assert.rejects(
      claw.assistant.startReviews("tok", { ...request, actingToken: "t", actingKey: "k" }),
      CredentialMisuse,
    );
    assert.deepEqual(wire.sent, []);
  });

  it("a refusal of them all, a Claw without the route, and an answer that is not one", async () => {
    const wire = new Wire(() =>
      json(429, { ok: false, error: "too_many_requested_reviews", message: "Too many.", data: { limit: 3 } }),
    );
    const err = await wire
      .client()
      .assistant.startReviews("tok", request)
      .catch((e: unknown) => e);
    assert.ok(err instanceof ReviewsRefused);
    assert.deepEqual(
      [err.status, err.error, err.said, err.data],
      [429, "too_many_requested_reviews", "Too many.", { limit: 3 }],
    );
    wire.answer = () => json(400, { ok: false, error: "bad", data: [1] });
    const bare = await wire
      .client()
      .assistant.startReviews("tok", request)
      .catch((e: unknown) => e);
    assert.ok(bare instanceof ReviewsRefused);
    assert.deepEqual([bare.said, bare.data], ["", {}]);
    wire.answer = () => json(404, { ok: false, error: "not_found" });
    await assert.rejects(
      wire.client().assistant.startReviews("tok", request),
      (e: unknown) => e instanceof ClawError && !(e instanceof ReviewsRefused),
    );
    wire.answer = () => new Response("<html>", { status: 502 });
    await assert.rejects(
      wire.client().assistant.startReviews("tok", request),
      (e: unknown) => e instanceof ClawError && !(e instanceof ReviewsRefused),
    );
    wire.answer = () => new Response("<html>", { status: 200 });
    await assert.rejects(wire.client().assistant.startReviews("tok", request), ClawAnswerInvalid);
  });
});
