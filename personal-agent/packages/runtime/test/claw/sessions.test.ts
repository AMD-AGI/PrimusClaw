// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawAnswerInvalid, ClawError, ClawUnreachable, CredentialMisuse } from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

const created = (): Response => json(200, { data: { session_id: "s1", message: { message_id: "m1" } } });

describe("making a session", () => {
  it("sends its config, its model and the model key beside a token", async () => {
    const wire = new Wire(created);
    const claw = wire.client({ model: "worker-model" });
    const out = await claw.sessions.create("exchanged", {
      text: "Review https://github.com/o/r/pull/1 please, it is a long message that is cut",
      idempotencyKey: "idem-1",
      repo: { url: "https://github.com/o/r", branch: "" },
      actingAs: "u-1",
      reviewTarget: { owner: "o", repo: "r", number: 1 },
      modelKey: "ak-own",
      model: "review-model",
      reviewOnly: true,
      shared: true,
    });
    assert.deepEqual(out, { sessionId: "s1", messageId: "m1" });
    const [sent] = wire.sent;
    assert.ok(sent);
    assert.equal(sent.headers.get("idempotency-key"), "idem-1");
    assert.equal(sent.headers.get("x-api-key"), "ak-own");
    assert.deepEqual(sent.body, {
      name: "Review https://github.com/o/r/pull/1 please, it is",
      mode: "claw",
      config: {
        notify_on_finish: true,
        repo: { url: "https://github.com/o/r" },
        acting_as: "u-1",
        memory: "off",
        review_target: { owner: "o", repo: "r", number: 1 },
        review_only: true,
      },
      message: {
        content: "Review https://github.com/o/r/pull/1 please, it is a long message that is cut",
        messageType: "text",
      },
      model: "review-model",
    });
  });

  it("without a message, and with the worker's own model or none", async () => {
    const wire = new Wire(() => json(200, { data: { session_id: "s2" } }));
    const out = await wire.client({ model: "worker-model", pluginId: 3 }).sessions.create("ak-a", {
      text: "files",
      idempotencyKey: "i",
      withMessage: false,
      repo: { url: "u", branch: "dev" },
    });
    assert.deepEqual(out, { sessionId: "s2", messageId: "" });
    assert.deepEqual(wire.sent[0]?.body, {
      name: "files",
      mode: "claw",
      config: { notify_on_finish: true, repo: { url: "u", branch: "dev" } },
      model: "worker-model",
    });
    const plain = new Wire(created);
    await plain.client({ pluginId: 3 }).sessions.create("ak-a", { text: "hi", idempotencyKey: "i" });
    assert.deepEqual(plain.sent[0]?.body, {
      name: "hi",
      mode: "claw",
      config: { notify_on_finish: true },
      message: { content: "hi", messageType: "text", pluginId: 3 },
    });
  });
});

describe("making a session, refused", () => {
  it("refuses an API key where only a token may go, before anything is sent", async () => {
    const wire = new Wire(created);
    const claw = wire.client();
    await assert.rejects(
      claw.sessions.create("ak-a", { text: "t", idempotencyKey: "i", actingAs: "u" }),
      CredentialMisuse,
    );
    await assert.rejects(
      claw.sessions.create("ak-a", { text: "t", idempotencyKey: "i", modelKey: "ak-b" }),
      CredentialMisuse,
    );
    await assert.rejects(claw.sessions.decide("ak-a", "s", "tu", "allow", { acting: true }), CredentialMisuse);
    await assert.rejects(claw.sessions.answer("ak-a", "s", "tu", {}, [], { acting: true }), CredentialMisuse);
    assert.deepEqual(wire.sent, []);
  });

  it("an answer without the session's id is not understood", async () => {
    const wire = new Wire(() => json(200, { data: { message: {} } }));
    await assert.rejects(wire.client().sessions.create("ak-a", { text: "t", idempotencyKey: "i" }), ClawAnswerInvalid);
    const empty = new Wire(() => json(200, { ok: true }));
    await assert.rejects(empty.client().sessions.create("ak-a", { text: "t", idempotencyKey: "i" }), ClawAnswerInvalid);
  });
});

describe("writing into a session", () => {
  it("a message's id, or none when Claw queued it; acting messages go as the text alone", async () => {
    const wire = new Wire(() => json(200, { ok: true, message_id: "m9" }));
    const claw = wire.client({ pluginId: 2, ruleToolId: null });
    assert.equal(await claw.sessions.sendMessage("tok", "s", "hi", { acting: true, modelKey: "ak-own" }), "m9");
    assert.deepEqual(wire.sent[0]?.body, { content: "hi", messageType: "text" });
    assert.equal(wire.sent.at(0)?.headers.get("x-api-key") ?? null, "ak-own");
    wire.answer = () => json(200, { ok: true, queued: true });
    assert.equal(await claw.sessions.sendMessage("ak-a", "s", "hi"), null);
    wire.answer = () => json(200, { ok: true });
    await assert.rejects(claw.sessions.sendMessage("ak-a", "s", "hi"), ClawAnswerInvalid);
    wire.answer = () => json(200, ["x"]);
    await assert.rejects(claw.sessions.sendMessage("ak-a", "s", "hi"), ClawAnswerInvalid);
  });

  it("answers, votes and models go as Claw takes them", async () => {
    const wire = new Wire(() => json(200, { ok: true }));
    const claw = wire.client();
    await claw.sessions.answer("tok", "s", "tu", { q1: "yes" }, ["q2"], { acting: true });
    await claw.sessions.vote("ak-a", "s", "m1", "down", "wrong");
    await claw.sessions.vote("ak-a", "s", "m1", "up");
    await claw.sessions.setModel("ak-a", "s", "m");
    await claw.sessions.checkKey("ak-a");
    assert.deepEqual(
      wire.sent.map((s) => [s.method, s.rawPath + s.url.search, s.body]),
      [
        [
          "POST",
          "/v1/sessions/s/messages",
          { messageType: "answer", extData: { tool_use_id: "tu", answers: { q1: "yes" }, skipped: ["q2"] } },
        ],
        ["PUT", "/v1/sessions/s/feedback", { message_id: "m1", vote: "down", reason: "wrong" }],
        ["PUT", "/v1/sessions/s/feedback", { message_id: "m1", vote: "up" }],
        ["PATCH", "/v1/sessions/s", { model: "m" }],
        ["GET", "/v1/sessions?limit=1", undefined],
      ],
    );
  });

  it("a refused key is a ClawError with its status", async () => {
    const wire = new Wire(() => json(401, { ok: false, error: "invalid_api_key" }));
    const err = await wire
      .client()
      .sessions.checkKey("ak-a")
      .catch((e: unknown) => e);
    assert.ok(err instanceof ClawError);
    assert.equal(err.status, 401);
    assert.equal(err.code, "invalid_api_key");
  });

  it("files go into the session's workspace, and what Claw did not take is named", async () => {
    const wire = new Wire(() => json(200, { uploaded: [{ path: "f/a.txt" }, { path: "" }, "x"] }));
    const out = await wire.client().sessions.uploadFiles("ak-a", "s", "f", [
      { name: "a.txt", content: new Uint8Array([97]), mediaType: "text/plain" },
      { name: "b.bin", content: new Uint8Array([0]), mediaType: "application/octet-stream" },
    ]);
    assert.deepEqual(out, { paths: ["/workspace/.uploads/f/a.txt"], refused: ["b.bin"] });
    const [sent] = wire.sent;
    assert.ok(sent?.form);
    assert.equal(sent.url.searchParams.get("ttl_days"), "7");
    const files = sent.form.getAll("file") as File[];
    assert.deepEqual(
      files.map((f) => [f.name, f.type]),
      [
        ["f/a.txt", "text/plain"],
        ["f/b.bin", "application/octet-stream"],
      ],
    );
    const none = new Wire(() => json(200, {}));
    assert.deepEqual(await none.client().sessions.uploadFiles("ak-a", "s", "f", []), { paths: [], refused: [] });
  });
});

describe("reading a session", () => {
  it("whether a turn holds it, and that turn's id", async () => {
    const wire = new Wire(() => json(200, { data: { agent_status: "running", agent_gate_message_id: "m3" } }));
    assert.deepEqual(await wire.client().sessions.turn("ak-a", "s"), { running: true, messageId: "m3" });
    wire.answer = () => json(200, { data: { agent_status: "running" } });
    assert.deepEqual(await wire.client().sessions.turn("ak-a", "s"), { running: true, messageId: null });
    wire.answer = () => json(200, { data: { agent_status: "idle", agent_gate_message_id: "m3" } });
    assert.deepEqual(await wire.client().sessions.turn("ak-a", "s"), { running: false, messageId: null });
  });

  it("what it changed, bounded in size and time", async () => {
    const wire = new Wire(() => json(200, { ok: true, repos: [] }));
    assert.deepEqual(await wire.client().sessions.changes("ak-a", "s", 5000), { ok: true, repos: [] });
    assert.equal(wire.sent[0]?.rawPath, "/v1/sessions/s/changes");
    wire.answer = () => json(409, { ok: false, error: "sandbox_not_running" });
    await assert.rejects(wire.client().sessions.changes("ak-a", "s", 5000), { name: "ClawError", status: 409 });
    const slow = new Wire(
      (sent) =>
        new Promise<Response>((_, reject) => {
          sent.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "TimeoutError"));
          });
        }),
    );
    await assert.rejects(slow.client().sessions.changes("ak-a", "s", 20), ClawUnreachable);
  });

  it("the link is claw's own and only over https", () => {
    const claw = new Wire().client();
    assert.equal(
      claw.sessions.deliveryLink("s 1/x", "d/2"),
      "https://claw.test/v1/sessions/s%201%2Fx/deliveries/d%2F2",
    );
    assert.equal(new Wire().client({ baseUrl: "http://claw.local" }).sessions.deliveryLink("s", "d"), null);
  });

  it("a network failure is ClawUnreachable, never the library's error", async () => {
    const wire = new Wire(() => Promise.reject(new TypeError("fetch failed: https://claw.test/?token=x")));
    const err = await wire
      .client()
      .sessions.checkKey("ak-a")
      .catch((e: unknown) => e);
    assert.ok(err instanceof ClawUnreachable);
    assert.equal(err.kind, "network");
    assert.ok(!err.message.includes("token"));
  });
});

describe("how Claw was not reached", () => {
  const failed = (cause: Error): TypeError => new TypeError("fetch failed", { cause });
  const coded = (code: string): Error => Object.assign(new Error(`connect ${code} 10.0.0.1:443`), { code });
  const cases: Array<[string, () => Error, string]> = [
    ["a refused connection", () => failed(coded("ECONNREFUSED")), "connect"],
    ["no such host", () => failed(coded("ENOTFOUND")), "connect"],
    ["a connection not made in time", () => failed(coded("UND_ERR_CONNECT_TIMEOUT")), "timeout"],
    ["an answer not in time", () => new DOMException("timed out", "TimeoutError"), "timeout"],
    ["a connection reset after sending", () => failed(coded("ECONNRESET")), "network"],
    ["an error without a code", () => new TypeError("fetch failed"), "network"],
  ];
  for (const [what, error, kind] of cases) {
    it(`a request that never went out is told apart: ${what}`, async () => {
      const wire = new Wire(() => Promise.reject(error()));
      const err = await wire
        .client()
        .sessions.turn("ak-a", "s1")
        .catch((e: unknown) => e);
      assert.ok(err instanceof ClawUnreachable);
      assert.equal(err.kind, kind);
      assert.equal(err.message.includes("10.0.0.1"), false);
    });
  }
});
