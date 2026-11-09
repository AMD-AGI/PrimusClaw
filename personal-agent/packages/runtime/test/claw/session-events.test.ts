// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A session's stored events (`?mode=replay`): the tail, the byte limit, and what a refused or failed reply is. */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { ClawError, ReplayRefused } from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

function row(n: number, pad = 0): Record<string, unknown> {
  return {
    event_id: `e${String(n)}`,
    event_type: "message",
    data: { type: "AssistantMessage", n, text: "x".repeat(pad) },
    created_at: "2026-11-08T00:00:00Z",
  };
}

/** A body served in 64 KiB pieces, counting what was handed out (what a reader pulled off the wire). */
class Pieces {
  sent = 0;
  constructor(readonly body: Uint8Array) {}

  stream(): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream({
      pull: (controller) => {
        if (at >= this.body.byteLength) {
          controller.close();
          return;
        }
        const piece = this.body.subarray(at, at + 65536);
        at += piece.byteLength;
        this.sent += piece.byteLength;
        controller.enqueue(piece);
      },
    });
  }
}

/** A Claw that predates `tail`: it answers every replay with the whole history. */
function oldClaw(rows: unknown[], status = 200): { wire: Wire; body: Pieces } {
  const body = new Pieces(new TextEncoder().encode(JSON.stringify({ ok: true, data: rows })));
  const wire = new Wire(() => new Response(body.stream(), { status }));
  return { wire, body };
}

describe("session events", () => {
  it("the client refuses a reply past max bytes and a compressed one", async () => {
    const { wire, body } = oldClaw(Array.from({ length: 2000 }, (_, i) => row(i + 1, 900)));
    await assert.rejects(wire.client().sessions.events("ak-a", "s1", { tail: 5, maxBytes: 100_000 }), ReplayRefused);
    assert.ok(body.sent <= 100_000 + 65536 * 2);
    assert.equal(wire.sent[0]?.headers.get("accept-encoding"), "identity");
    const squeezed = new Wire(
      () => new Response(gzipSync('{"ok":true,"data":[]}'), { status: 200, headers: { "content-encoding": "gzip" } }),
    );
    await assert.rejects(
      squeezed.client().sessions.events("ak-a", "s1", { tail: 5, maxBytes: 100_000 }),
      ReplayRefused,
    );
  });

  it("an error reply is a claw error quoted from its start", async () => {
    const { wire, body } = oldClaw(
      Array.from({ length: 2000 }, (_, i) => row(i + 1, 900)),
      500,
    );
    const err = await wire
      .client()
      .sessions.events("ak-a", "s1", { tail: 5, maxBytes: 4 * 1024 * 1024 })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(err instanceof ClawError);
    assert.equal(err.status, 500);
    assert.equal(err.detail.length, 200);
    assert.ok(body.sent <= 65536 * 2);
  });

  it("without tail or max bytes the replay is the whole history as before", async () => {
    const { wire } = oldClaw(Array.from({ length: 1000 }, (_, i) => row(i + 1)));
    const rows = await wire.client().sessions.events("ak-a", "s1");
    assert.equal(rows.length, 1000);
    assert.equal(wire.sent.length, 1);
    assert.equal(wire.sent[0]?.url.searchParams.get("tail"), null);
    assert.equal(wire.sent[0]?.url.searchParams.get("mode"), "replay");
  });

  it("an older claw's whole history is cut to the tail here", async () => {
    const { wire } = oldClaw([...Array.from({ length: 10 }, (_, i) => row(i + 1)), "not a row"]);
    const rows = await wire.client().sessions.events("ak-a", "s1", { tail: 3 });
    assert.deepEqual(
      rows.map((r) => r["event_id"]),
      ["e8", "e9", "e10"],
    );
    assert.equal(wire.sent[0]?.url.searchParams.get("tail"), "3");
  });

  it("a tail below one is refused before anything is sent", async () => {
    const { wire } = oldClaw([row(1)]);
    await assert.rejects(wire.client().sessions.events("ak-a", "s1", { tail: 0 }), RangeError);
    assert.deepEqual(wire.sent, []);
  });

  it("the newest event id is read from a bounded tail of one", async () => {
    const wire = new Wire(() => json(200, { ok: true, data: [row(7)] }));
    assert.equal(await wire.client().sessions.lastEventId("ak-a", "s1"), "e7");
    assert.equal(wire.sent[0]?.url.searchParams.get("tail"), "1");
    const none = new Wire(() => json(200, { ok: true, data: [] }));
    assert.equal(await none.client().sessions.lastEventId("ak-a", "s1"), null);
    const blank = new Wire(() => json(200, { ok: true, data: [{ event_id: "" }] }));
    assert.equal(await blank.client().sessions.lastEventId("ak-a", "s1"), null);
  });

  it("a replay that is not a list is an answer this client does not understand", async () => {
    const wire = new Wire(() => json(200, { ok: true, data: { rows: [] } }));
    await assert.rejects(wire.client().sessions.events("ak-a", "s1"), { name: "ClawAnswerInvalid" });
    const html = new Wire(() => new Response("<html>"));
    await assert.rejects(html.client().sessions.events("ak-a", "s1", { maxBytes: 100 }), { name: "ClawAnswerInvalid" });
  });
});
