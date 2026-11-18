// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Claw client's contract on the wire for a review for a colleague and the answers it carries (the Python worker's
 * ClawClient as test_github_review, test_github_review_many, test_review_items and test_github_repo_scope drive it):
 * which credential goes where, what refuses before anything goes out, and what Claw's answers are read as.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClawAnswerInvalid,
  ClawError,
  CredentialMisuse,
  ReviewsRefused,
  parseStartedReviews,
  type StartReviews,
} from "@primusclaw/personal-agent";
import { json, Wire, type Sent } from "./wire.js";

const BASE = "https://claw.test/claw-api";
const PR = { owner: "AMD-AGI", repo: "Hyperloom", number: 12 };
const PR2 = { owner: "AMD-AGI", repo: "Hyperloom", number: 13 };
const PR3 = { owner: "AMD-AGI", repo: "Primus", number: 3 };
const created = (): Response => json(200, { ok: true, data: { session_id: "s1", message: { message_id: "m1" } } });
const ask = (prs: Array<typeof PR>, extra: Partial<StartReviews> = {}): StartReviews => ({
  modelKey: "",
  prs: prs.map((pull) => ({ pull, message: "x" })),
  actingAs: "u-bob",
  actingAsName: "Bob",
  reviewOnly: false,
  model: "",
  ...extra,
});
const bodyOf = (sent: Sent | undefined): Record<string, unknown> => sent?.body as Record<string, unknown>;

/** The `i`-th request the wire saw (from the end when negative). */
function at(wire: Wire, i: number): Sent {
  const sent = wire.sent.at(i);
  if (sent === undefined) throw new Error(`no request ${String(i)}`);
  return sent;
}

/** Reads a stream to its end. */
async function drain(events: AsyncIterable<unknown>): Promise<void> {
  const iterator = events[Symbol.asyncIterator]();
  while (!(await iterator.next()).done);
}

describe("the session of a review for a colleague", () => {
  it("the client puts the reviewer in the session config and refuses a key for it before anything goes out", async () => {
    const wire = new Wire((sent) =>
      sent.rawPath.endsWith("/v1/sessions") ? created() : json(200, { ok: true, data: {} }),
    );
    const claw = wire.client({ baseUrl: BASE });
    await assert.rejects(
      claw.sessions.create("ak-linked-key", { text: "review", idempotencyKey: "idem-1", actingAs: "u-bob" }),
      CredentialMisuse,
    );
    assert.deepEqual(wire.sent, []);
    await claw.sessions.create("eyJ.header.sig", { text: "review", idempotencyKey: "idem-2", actingAs: "u-bob" });
    const made = at(wire, 0);
    assert.equal(made.headers.get("authorization"), "Bearer eyJ.header.sig");
    assert.equal((bodyOf(made)["config"] as Record<string, unknown>)["acting_as"], "u-bob");
    await claw.sessions.create("ak-linked-key", { text: "plain chat", idempotencyKey: "idem-3" });
    assert.ok(!("acting_as" in (bodyOf(at(wire, -1))["config"] as Record<string, unknown>)));
  });

  it("the client carries the model key beside the token and nowhere else", async () => {
    const wire = new Wire((sent) =>
      sent.rawPath.endsWith("/v1/sessions") ? created() : json(200, { ok: true, message_id: "m2" }),
    );
    const claw = wire.client({ baseUrl: BASE });
    await claw.sessions.create("eyJ.header.sig", {
      text: "review",
      idempotencyKey: "idem-1",
      actingAs: "u-bob",
      reviewTarget: PR,
      modelKey: "ak-asker",
    });
    await claw.sessions.sendMessage("eyJ.header.sig", "s1", "again", { modelKey: "ak-asker" });
    await claw.sessions.create("eyJ.header.sig", { text: "plain", idempotencyKey: "idem-2" });
    await claw.sessions.sendMessage("eyJ.header.sig", "s1", "plain");
    assert.deepEqual(
      wire.sent.map((s) => s.headers.get("x-api-key")),
      ["ak-asker", "ak-asker", null, null],
    );
    assert.deepEqual(new Set(wire.sent.map((s) => s.headers.get("authorization"))), new Set(["Bearer eyJ.header.sig"]));
    assert.deepEqual((bodyOf(wire.sent[0])["config"] as Record<string, unknown>)["review_target"], PR);
    assert.ok(!("review_target" in (bodyOf(wire.sent[2])["config"] as Record<string, unknown>)));
    const before = wire.sent.length;
    await assert.rejects(
      claw.sessions.create("ak-linked", { text: "x", idempotencyKey: "idem-3", modelKey: "ak-asker" }),
      CredentialMisuse,
    );
    await assert.rejects(claw.sessions.sendMessage("ak-linked", "s1", "x", { modelKey: "ak-asker" }), CredentialMisuse);
    assert.equal(wire.sent.length, before);
  });

  it("on the wire the named model is the session's model and without one none is added", async () => {
    const wire = new Wire(created);
    const claw = wire.client({ baseUrl: BASE });
    for (const [pull, model] of [
      [PR, "gpt-6-luna"],
      [PR2, "gpt-6-luna"],
      [PR3, ""],
    ] as const) {
      await claw.sessions.create("eyJ.tok", {
        text: "review",
        idempotencyKey: `i-${String(pull.number)}`,
        actingAs: "u-bob",
        reviewTarget: pull,
        model,
      });
    }
    assert.deepEqual(
      wire.sent.map((s) => bodyOf(s)["model"]),
      ["gpt-6-luna", "gpt-6-luna", undefined],
    );
    assert.deepEqual(
      wire.sent.map((s) => ((bodyOf(s)["config"] as Record<string, unknown>)["review_target"] as typeof PR).number),
      [12, 13, 3],
    );
  });
});

describe("answers in a session that acts as a user, and held merges", () => {
  it("the client sends the exchanged token for an answer in a session that acts as a user and refuses a key before anything goes out", async () => {
    const wire = new Wire(() => json(200, { ok: true }));
    const claw = wire.client({ baseUrl: BASE });
    await claw.sessions.decide("eyJ.header.sig", "s1", "tu1", "allow", { acting: true });
    const request = at(wire, 0);
    assert.deepEqual([request.method, request.rawPath], ["POST", "/claw-api/v1/sessions/s1/messages"]);
    assert.equal(request.headers.get("authorization"), "Bearer eyJ.header.sig");
    assert.deepEqual(request.body, { messageType: "decision", extData: { tool_use_id: "tu1", action: "allow" } });
    await assert.rejects(
      claw.sessions.decide("ak-linked-key", "s1", "tu1", "allow", { acting: true }),
      CredentialMisuse,
    );
    assert.equal(wire.sent.length, 1);
    await claw.sessions.decide("ak-linked-key", "s1", "tu1", "deny");
    assert.equal(at(wire, 1).headers.get("authorization"), "Bearer ak-linked-key");
  });

  it("the client sends the exchanged token to the decision route and refuses a key before anything goes out", async () => {
    const wire = new Wire(() => json(200, { ok: true, status: "merged", merge_sha: "abc" }));
    const claw = wire.client({ baseUrl: BASE });
    assert.equal((await claw.mergeConfirmations.decide("eyJ.header.sig", "cf-1", "allow"))["status"], "merged");
    const request = at(wire, 0);
    assert.deepEqual(
      [request.method, request.rawPath],
      ["POST", "/claw-api/v1/github-review/confirmations/cf-1/decision"],
    );
    assert.equal(request.headers.get("authorization"), "Bearer eyJ.header.sig");
    assert.deepEqual(request.body, { decision: "allow" });
    await assert.rejects(claw.mergeConfirmations.decide("ak-linked-key", "cf-1", "allow"), CredentialMisuse);
    assert.equal(wire.sent.length, 1);
  });

  it("on the wire a held review is answered at the decision route with the reviewer's token and the choice", async () => {
    const wire = new Wire(() => json(200, { ok: true, status: "submitted", review_id: 5, url: null }));
    const out = await wire.client({ baseUrl: BASE }).mergeConfirmations.decide("tok-aad-b", "cf-1", "allow");
    const decision = at(wire, 0);
    assert.deepEqual(
      [decision.method, decision.rawPath],
      ["POST", "/claw-api/v1/github-review/confirmations/cf-1/decision"],
    );
    assert.equal(decision.headers.get("authorization"), "Bearer tok-aad-b");
    assert.equal(decision.headers.get("x-api-key"), null);
    assert.deepEqual(decision.body, { decision: "allow" });
    assert.equal(out["review_id"], 5);
  });

  it("the client hands the queued answer over as claw sends it", async () => {
    const queued = {
      status: "queued",
      queue_entry_id: "MQE_kwDO",
      queue_position: 3,
      queue_state: "AWAITING_CHECKS",
      url: "https://github.com/AMD-AGI/Hyperloom/pull/12",
    };
    const wire = new Wire(() => json(200, { ok: true, ...queued }));
    const out = await wire.client({ baseUrl: BASE }).mergeConfirmations.decide("eyJ.header.sig", "cf-1", "allow");
    assert.deepEqual(
      [out["status"], out["queue_position"], out["queue_state"], out["queue_entry_id"]],
      ["queued", 3, "AWAITING_CHECKS", "MQE_kwDO"],
    );
  });

  it("a refusal from claw carries the reason it named", () => {
    for (const [body, code] of [
      ['{"ok":false,"error":"service_client_not_allowed"}', "service_client_not_allowed"],
      ["{}", ""],
      ["junk", ""],
      ['["x"]', ""],
    ] as const) {
      assert.equal(new ClawError(403, body).code, code, body);
    }
    assert.equal(new ClawError(500).code, "");
  });
});

describe("the credentials of a whole review, call by call", () => {
  it("on the wire the token is the only credential and the asker's key rides only the call that makes the session", async () => {
    const done = JSON.stringify({ message_id: "m1", final_text: "VERDICT: CLEAN", data: { subtype: "success" } });
    const wire = new Wire((sent) => {
      const path = sent.rawPath;
      if (sent.method === "POST" && path.endsWith("/v1/sessions")) return created();
      if (sent.method === "GET" && path.endsWith("/messages")) {
        return new Response(`id: e1\nevent: ResultMessage\ndata: ${done}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path.endsWith("/github-review/confirmations"))
        return json(200, { items: [{ id: "cf-1", session_id: "s1" }] });
      if (path.endsWith("/decision")) return json(200, { data: { status: "merged", merge_sha: "0123456789abcdef" } });
      return json(404, { ok: false });
    });
    const claw = wire.client({ baseUrl: BASE });
    // (the order the review delegation makes these calls in: the reviewer's mode, model choice, review items, then a
    // session made here when the items are missing, its stream, the held merge, and the reviewer's answer)
    await claw.settings.reviewMode("tok-aad-b").catch(() => "");
    assert.equal(await claw.settings.assistantSettings("tok-aad-a"), null);
    await assert.rejects(
      claw.assistant.startReviews("tok-aad-a", ask([PR], { actingToken: "tok-aad-b", actingKey: "ak-bob" })),
      { name: "ClawError", status: 404 },
    );
    await claw.sessions.create("tok-aad-a", {
      text: "review",
      idempotencyKey: "i",
      actingAs: "u-bob",
      reviewTarget: PR,
      modelKey: "ak-alice",
    });
    await drain(claw.sessions.stream("tok-aad-a", "s1"));
    await claw.mergeConfirmations.pending("tok-aad-a", "s1");
    await claw.mergeConfirmations.decide("tok-aad-b", "cf-1", "allow");
    assert.deepEqual(
      wire.sent.map((s) => [s.method, s.rawPath]),
      [
        ["GET", "/claw-api/v1/github-review/settings"],
        ["GET", "/claw-api/v1/assistant/settings"],
        ["POST", "/claw-api/v1/assistant/reviews"],
        ["POST", "/claw-api/v1/sessions"],
        ["GET", "/claw-api/v1/chat/sessions/s1/messages"],
        ["GET", "/claw-api/v1/github-review/confirmations"],
        ["POST", "/claw-api/v1/github-review/confirmations/cf-1/decision"],
      ],
    );
    assert.deepEqual(
      wire.sent.map((s) => s.headers.get("authorization")),
      ["Bearer tok-aad-b", ...Array<string>(5).fill("Bearer tok-aad-a"), "Bearer tok-aad-b"],
    );
    assert.deepEqual(
      wire.sent.filter((s) => s.headers.get("x-api-key") !== null).map((s) => [s.method, s.rawPath]),
      [["POST", "/claw-api/v1/sessions"]],
    );
    assert.equal(at(wire, 2).headers.get("x-acting-as-token"), "tok-aad-b");
    assert.equal(at(wire, 2).headers.get("x-acting-as-api-key"), "ak-bob");
    assert.equal(at(wire, 3).headers.get("x-api-key"), "ak-alice");
    const config = bodyOf(wire.sent[3])["config"] as Record<string, unknown>;
    assert.deepEqual([config["review_target"], config["acting_as"]], [PR, "u-bob"]);
    assert.ok(
      !wire.sent
        .map((s) => s.headers.get("authorization"))
        .join(" ")
        .includes("ak-alice"),
    );
  });
});

describe("what the client reads with a person's key", () => {
  it("the client lists the models with the key it is given and never reads a failure as none", async () => {
    const answers = [
      json(200, { object: "list", data: [{ id: "a" }, { id: "" }, { x: 1 }, "b", { id: "c", owned_by: "o" }] }),
      json(503, { error: "llm_key_unavailable" }),
      json(200, { object: "list" }),
    ];
    const wire = new Wire(() => answers.shift() ?? json(500, {}));
    const claw = wire.client({ baseUrl: BASE });
    assert.deepEqual(await claw.settings.models("ak-alice"), ["a", "c"]);
    for (let i = 0; i < 2; i += 1) await assert.rejects(claw.settings.models("ak-alice"), ClawError);
    assert.deepEqual([at(wire, 0).method, at(wire, 0).rawPath], ["GET", "/claw-api/v1/models"]);
    assert.equal(at(wire, 0).headers.get("authorization"), "Bearer ak-alice");
  });

  it("the client puts the setting as the key owner", async () => {
    const wire = new Wire(() => json(200, { ok: true, data: { enabled: false, available: true } }));
    assert.deepEqual(await wire.client({ baseUrl: BASE }).settings.setMemory("ak-alice", false), {
      enabled: false,
      available: true,
    });
    assert.deepEqual(
      wire.sent.map((s) => [s.method, s.rawPath, s.headers.get("authorization"), s.body]),
      [["PUT", "/claw-api/v1/users/me/memory-settings", "Bearer ak-alice", { enabled: false }]],
    );
  });
});

describe("starting reviews", () => {
  const nothingGoesOut = (): Wire =>
    new Wire(() => {
      throw new Error("sent");
    });

  it("the client never starts reviews with an api key", async () => {
    const wire = nothingGoesOut();
    await assert.rejects(wire.client().assistant.startReviews("ak-linked", ask([PR])), CredentialMisuse);
    assert.deepEqual(wire.sent, []);
  });

  it("the client never asks for someone else without their key or with a key as their token", async () => {
    const wire = nothingGoesOut();
    for (const [actingToken, actingKey] of [
      ["eyJ.bob", ""],
      ["eyJ.bob", "eyJ.not-a-key"],
      ["ak-bob", "ak-bob"],
    ] as const) {
      await assert.rejects(
        wire.client().assistant.startReviews("eyJ.alice", ask([PR], { actingToken, actingKey })),
        CredentialMisuse,
      );
    }
    assert.deepEqual(wire.sent, []);
  });

  it("the requester note is clipped to what claw takes", async () => {
    const wire = new Wire(() => json(200, { ok: true, data: { items: [] } }));
    await wire
      .client()
      .assistant.startReviews(
        "eyJ.alice",
        ask([PR], { actingToken: "eyJ.bob", actingKey: "ak-bob", requesterNote: "字".repeat(3000) }),
      );
    assert.equal(Array.from(bodyOf(wire.sent[0])["requester_note"] as string).length, 2000);
  });

  it("a refusal is read from the whole answer, not from its first 200 characters", async () => {
    const body = { ok: false, error: "pr_check_failed", message: "y".repeat(400), data: { pr: PR, reason: "draft" } };
    const err = await new Wire(() => json(422, body))
      .client()
      .assistant.startReviews("eyJ.tok", ask([PR], { modelKey: "ak-x", reviewOnly: true }))
      .catch((e: unknown) => e);
    assert.ok(err instanceof ReviewsRefused);
    assert.deepEqual(
      [err.status, err.error, err.data["reason"], err.said.length],
      [422, "pr_check_failed", "draft", 400],
    );
  });

  it("a 404 is how the client says the route is missing", async () => {
    const answer = { message: "Route POST:/v1/assistant/reviews not found", error: "Not Found" };
    const err = await new Wire(() => json(404, answer))
      .client()
      .assistant.startReviews("eyJ.tok", ask([PR], { modelKey: "ak-x", reviewOnly: true, model: "m" }))
      .catch((e: unknown) => e);
    assert.ok(err instanceof ClawError && err.status === 404 && !(err instanceof ReviewsRefused));
  });
});

describe("the request for reviews, replayed", () => {
  const replay: Array<[string, Array<typeof PR>, boolean, string]> = [
    ["several, one line", [PR, PR2, PR3], false, ""],
    ["one", [PR], false, ""],
    ["spaces only", [PR, PR2], false, ""],
    ["review only on opus", [PR], true, "claude-opus-5.5"],
    ["a review is not a merge", [PR, PR2], true, ""],
    ["merge, model named", [PR2], false, "gpt-6-luna"],
  ];
  for (const [what, prs, reviewOnly, model] of replay) {
    it(`replay: the request claw gets is exactly the one asked for: ${what}`, async () => {
      const wire = new Wire(() => json(200, { ok: true, data: { items: [] } }));
      await wire.client().assistant.startReviews("eyJ.tok", ask(prs, { reviewOnly, model }));
      const body = bodyOf(wire.sent[0]);
      assert.deepEqual(
        (body["prs"] as Array<Record<string, unknown>>).map((p) => ({
          owner: p["owner"],
          repo: p["repo"],
          number: p["number"],
        })),
        prs,
      );
      assert.deepEqual(
        [body["acting_as"], body["review_only"], body["model"]],
        ["u-bob", reviewOnly, model === "" ? undefined : model],
      );
    });
  }
});

describe("reading started reviews", () => {
  const target = { owner: "AMD-AGI", repo: "Hyperloom", number: 12 };
  const cannot: Array<[string, unknown]> = [
    ["no session", { items: [{ item_id: "i", pr: target }] }],
    ["no pull request", { items: [{ item_id: "i", session_id: "s" }] }],
    ["no item", { items: [{ session_id: "s", pr: target }] }],
    ["not a list", { items: "x" }],
    ["nothing", null],
  ];
  for (const [what, data] of cannot) {
    it(`an answer that cannot be followed is not understood: ${what}`, () => {
      assert.throws(() => parseStartedReviews(data), ClawAnswerInvalid);
    });
  }

  it("reviews asked of someone else need no session but still their item and pull", () => {
    const [one] = parseStartedReviews({ items: [{ item_id: "i", seq: 3, pr: target }] }, false);
    assert.deepEqual([one?.itemId, one?.seq, one?.sessionId], ["i", 3, ""]);
    for (const raw of [{ item_id: "i" }, { pr: target }]) {
      assert.throws(() => parseStartedReviews({ items: [raw] }, false), ClawAnswerInvalid);
    }
  });
});
