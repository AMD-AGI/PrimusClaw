// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawAnswerInvalid, ClawError, CredentialMisuse } from "@primusclaw/personal-agent";
import { json, Wire, type Sent } from "./wire.js";

describe("a person's settings", () => {
  it("memory: on or off, whether Claw has it, and what it remembers apart from the profile", async () => {
    const wire = new Wire((sent: Sent) =>
      sent.rawPath.endsWith("memory-settings")
        ? json(200, { data: { enabled: true } })
        : json(200, {
            data: [
              { content: "likes tea", category: "fact" },
              { content: "Lin", category: "user_profile" },
              { category: "fact" },
              { content: 3 },
              { content: null },
              { content: false },
            ],
          }),
    );
    assert.deepEqual(await wire.client().settings.memory("ak-a"), {
      enabled: true,
      available: true,
      items: ["likes tea", "", "3", "None", "False"],
    });
    assert.deepEqual((await wire.client().settings.memory("ak-a", 1)).items, ["likes tea"]);
    wire.answer = (sent) =>
      sent.rawPath.endsWith("memory-settings")
        ? json(200, { data: { enabled: [], available: {} } })
        : json(200, { data: [] });
    assert.deepEqual(await wire.client().settings.memory("ak-a"), { enabled: false, available: false, items: [] });
    wire.answer = () => json(200, { data: { enabled: false, available: null } });
    assert.deepEqual(await wire.client().settings.setMemory("ak-a", false), { enabled: false, available: false });
    assert.deepEqual(wire.sent.at(-1)?.body, { enabled: false });
  });
});

describe("a person's models and assistant settings", () => {
  it("the models a person may use; a Claw that cannot say is an error, never an empty list", async () => {
    const wire = new Wire(() => json(200, { data: [{ id: "a" }, { id: "" }, { id: 3 }, "b", { id: "c" }] }));
    assert.deepEqual(await wire.client().settings.models("ak-a"), ["a", "c"]);
    wire.answer = () => json(200, { data: {} });
    await assert.rejects(wire.client().settings.models("ak-a"), { name: "ClawError", status: 502 });
    wire.answer = () => json(503, { ok: false, error: "no_gateway" });
    await assert.rejects(wire.client().settings.models("ak-a"), { name: "ClawError", status: 503 });
  });

  it("the assistant's settings, or none from a Claw without them", async () => {
    const wire = new Wire(() => json(200, { data: { model: "m" } }));
    assert.deepEqual(await wire.client().settings.assistantSettings("tok"), { model: "m" });
    wire.answer = () => json(404, {});
    assert.equal(await wire.client().settings.assistantSettings("tok"), null);
    wire.answer = () => json(200, { data: [] });
    await assert.rejects(wire.client().settings.assistantSettings("tok"), { name: "ClawError", status: 502 });
    wire.answer = () => json(500, {});
    await assert.rejects(wire.client().settings.assistantSettings("tok"), { name: "ClawError", status: 500 });
    wire.answer = () => new Response("<html>");
    await assert.rejects(wire.client().settings.assistantSettings("tok"), ClawAnswerInvalid);
  });

  it("the review mode, read wherever Claw puts it, and set", async () => {
    const wire = new Wire(() => json(200, { data: { review_mode: "fully_auto" } }));
    assert.equal(await wire.client().settings.reviewMode("tok"), "fully_auto");
    wire.answer = () => json(200, { review_mode: "high_risk_confirm" });
    assert.equal(await wire.client().settings.reviewMode("tok"), "high_risk_confirm");
    wire.answer = () => json(200, { data: null });
    assert.equal(await wire.client().settings.reviewMode("tok"), "");
    await wire.client().settings.setReviewMode("tok", "fully_auto");
    assert.deepEqual(wire.sent.at(-1)?.body, { review_mode: "fully_auto" });
  });

  it("which GitHub token Claw would use, never the token", async () => {
    const wire = new Wire(() => json(200, { data: { reads_with: "binding", login: "lin-mei", binding_reads: true } }));
    assert.deepEqual(await wire.client().settings.githubConnection("tok"), {
      readsWith: "binding",
      login: "lin-mei",
      missing: "",
      bindingReads: true,
    });
    wire.answer = () => json(200, { data: { reads_with: "cookie", missing: "expired-and-more-than-twenty" } });
    assert.deepEqual(await wire.client().settings.githubConnection("tok"), {
      readsWith: "",
      login: "",
      missing: "expired-and-more-tha",
      bindingReads: false,
    });
    wire.answer = () => json(404, {});
    assert.equal(await wire.client().settings.githubConnection("tok"), null);
    wire.answer = () => json(200, {});
    await assert.rejects(wire.client().settings.githubConnection("tok"), ClawError);
  });
});

describe("notification subscriptions", () => {
  it("are listed, made with only the types asked for, changed and removed", async () => {
    const wire = new Wire(() => json(200, { data: { subscription_id: "sub1", secret: "s3cr3t" } }));
    const claw = wire.client();
    assert.equal(
      (await claw.notifications.create("ak-a", "https://w.test/claw-events", ["assistant.say"])).secret,
      "s3cr3t",
    );
    assert.deepEqual(wire.sent.at(-1)?.body, { url: "https://w.test/claw-events", event_types: ["assistant.say"] });
    await claw.notifications.create("ak-a", "https://w.test/claw-events", [], ["trigger"]);
    assert.deepEqual(wire.sent.at(-1)?.body, { url: "https://w.test/claw-events", sources: ["trigger"] });
    await claw.notifications.updateTypes("ak-a", "sub1", ["run.failed"]);
    assert.deepEqual(wire.sent.at(-1)?.body, { event_types: ["run.failed"] });
    await claw.notifications.updateTypes("ak-a", "sub1", ["run.failed"], { enable: true, sources: ["long_run"] });
    assert.deepEqual(wire.sent.at(-1)?.body, { event_types: ["run.failed"], sources: ["long_run"], enabled: true });
    await claw.notifications.delete("ak-a", "sub1");
    assert.deepEqual(
      wire.sent.slice(-3).map((s) => [s.method, s.rawPath]),
      [
        ["PATCH", "/v1/notification-subscriptions/sub1"],
        ["PATCH", "/v1/notification-subscriptions/sub1"],
        ["DELETE", "/v1/notification-subscriptions/sub1"],
      ],
    );
    wire.answer = () => json(200, { data: [{ subscription_id: "sub1" }] });
    assert.deepEqual(await claw.notifications.list("ak-a"), [{ subscription_id: "sub1" }]);
  });

  it("carry the worker's surface when it names one", async () => {
    const wire = new Wire(() => json(200, { data: { subscription_id: "sub1", secret: "s3cr3t" } }));
    const claw = wire.client();
    await claw.notifications.create("ak-a", "https://w.test/claw-events", [], [], "slack");
    assert.deepEqual(wire.sent.at(-1)?.body, { url: "https://w.test/claw-events", surface: "slack" });
    await claw.notifications.updateTypes("ak-a", "sub1", ["run.failed"], { surface: "slack" });
    assert.deepEqual(wire.sent.at(-1)?.body, { event_types: ["run.failed"], surface: "slack" });
  });
});

describe("triggers and held merges", () => {
  it("triggers as Claw answers them; a change does not send an action", async () => {
    const wire = new Wire(() => json(200, { data: { trigger_id: "t1" } }));
    const claw = wire.client();
    const trigger = { name: "n", prompt: "p", schedule: "0 9 * * *", timezone: "UTC" };
    await claw.triggers.create("ak-a", { ...trigger, action: "brief" });
    assert.deepEqual(wire.sent.at(-1)?.body, { ...trigger, action: "brief" });
    await claw.triggers.create("ak-a", trigger);
    assert.deepEqual(wire.sent.at(-1)?.body, trigger);
    await claw.triggers.update("ak-a", "t1", { ...trigger, action: "brief" });
    assert.deepEqual(wire.sent.at(-1)?.body, trigger);
    await claw.triggers.delete("ak-a", "t1");
    wire.answer = () => json(200, { data: [{ trigger_id: "t1" }] });
    assert.deepEqual(await claw.triggers.list("ak-a"), [{ trigger_id: "t1" }]);
  });

  it("the merges a session waits on, wherever Claw lists them", async () => {
    const wire = new Wire(() => json(200, { items: [{ id: "c1" }, 2] }));
    const claw = wire.client();
    assert.deepEqual(await claw.mergeConfirmations.pending("ak-a", "s 1"), [{ id: "c1" }]);
    assert.equal(wire.sent[0]?.url.search, "?session_id=s%201&status=pending");
    wire.answer = () => json(200, { data: { items: [{ id: "c2" }] } });
    assert.deepEqual(await claw.mergeConfirmations.pending("ak-a", "s"), [{ id: "c2" }]);
    wire.answer = () => json(200, { data: [{ id: "c3" }] });
    assert.deepEqual(await claw.mergeConfirmations.pending("ak-a", "s"), [{ id: "c3" }]);
    wire.answer = () => json(200, {});
    assert.deepEqual(await claw.mergeConfirmations.pending("ak-a", "s"), []);
  });

  it("a held merge is answered with a token only", async () => {
    const wire = new Wire(() => json(200, { data: { status: "merged", merge_sha: "abc" } }));
    const claw = wire.client();
    assert.deepEqual(await claw.mergeConfirmations.decide("tok", "cf/1", "allow"), {
      status: "merged",
      merge_sha: "abc",
    });
    assert.equal(wire.sent[0]?.rawPath, "/v1/github-review/confirmations/cf%2F1/decision");
    await assert.rejects(claw.mergeConfirmations.decide("ak-a", "cf1", "allow"), CredentialMisuse);
    await assert.rejects(claw.mergeConfirmations.decide("tok", "..", "allow"), { name: "ClawError", status: 404 });
    wire.answer = () => json(403, { ok: false, error: "only_the_acting_user_can_decide" });
    await assert.rejects(claw.mergeConfirmations.decide("tok", "cf1", "allow"), { name: "ClawError", status: 403 });
  });
});
