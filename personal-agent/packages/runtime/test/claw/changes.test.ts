// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session changed (`GET /v1/sessions/:id/changes`) on the wire: one bounded call, read as it is on the wire, a
 * reply too large refused before it is held, an error only quoted. Reading the reply is the turn's (core); here is only
 * what the client asks for and what it hands back.
 */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { ClawAnswerInvalid, ClawError, ClawUnreachable, ReplayRefused } from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

const MIXED = {
  ok: true,
  truncated: false,
  repos: [
    {
      path: "/workspace/app",
      branch: "main",
      head: "abc1234",
      truncated: false,
      files: [{ path: "a.py", status: "M", binary: false, additions: 3, deletions: 1 }],
      totals: { files: 1, additions: 3, deletions: 1 },
    },
  ],
};

/** A body handed out in pieces only as they are read, `pauseMs` apart, `count` times (undefined: for ever). */
class Pieces {
  sent = 0;
  constructor(
    readonly piece: Uint8Array,
    readonly pauseMs = 0,
    readonly count?: number,
  ) {}

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream(
      {
        pull: async (controller) => {
          if (this.count !== undefined && this.sent >= this.count) {
            controller.close();
            return;
          }
          this.sent += 1;
          if (this.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
          controller.enqueue(this.piece);
        },
      },
      { highWaterMark: 0 },
    );
  }
}

describe("a session's changes on the wire", () => {
  it("the whole call is bounded, not each read of it", async () => {
    const body = new Pieces(new TextEncoder().encode(" "), 50, 60);
    const wire = new Wire(() => new Response(body.stream()));
    const started = performance.now();
    await assert.rejects(wire.client().sessions.changes("ak-a", "s1", 300), ClawUnreachable);
    assert.ok(performance.now() - started < 2000);
    assert.ok(body.sent >= 3 && body.sent < 30, String(body.sent));
  });

  it("a reply larger than the worker reads is refused and not read to its end", async () => {
    const body = new Pieces(new Uint8Array(65536).fill(120));
    const wire = new Wire(() => new Response(body.stream()));
    await assert.rejects(wire.client().sessions.changes("ak-a", "s1", 5000), ReplayRefused);
    assert.ok(body.sent >= 15 && body.sent <= 18, String(body.sent));
  });

  it("a reply just under the limit is still read", async () => {
    const text = JSON.stringify(MIXED);
    const filler = " ".repeat(1_048_576 - text.length - 1);
    const wire = new Wire(() => new Response(text + filler));
    assert.deepEqual(await wire.client().sessions.changes("ak-a", "s1", 5000), MIXED);
  });

  it("an error body is only quoted and never read past its start", async () => {
    const body = new Pieces(new Uint8Array(65536).fill(101));
    const wire = new Wire(() => new Response(body.stream(), { status: 500 }));
    const err = await wire
      .client()
      .sessions.changes("ak-a", "s1", 5000)
      .catch((e: unknown) => e);
    assert.ok(err instanceof ClawError);
    assert.equal(err.status, 500);
    assert.ok(err.message.length <= 300);
    assert.equal(body.sent, 1);
  });

  it("the reply is asked for and read as it is on the wire, and a compressed one is refused", async () => {
    const wire = new Wire(() => json(200, MIXED));
    assert.deepEqual(await wire.client().sessions.changes("ak-a", "s1", 5000), MIXED);
    assert.equal(wire.sent[0]?.headers.get("accept-encoding"), "identity");
    const squeezed = new Wire(
      () => new Response(gzipSync(JSON.stringify(MIXED)), { headers: { "content-encoding": "gzip" } }),
    );
    await assert.rejects(squeezed.client().sessions.changes("ak-a", "s1", 5000), ReplayRefused);
    const plain = new Wire(() => new Response(JSON.stringify(MIXED), { headers: { "content-encoding": "identity" } }));
    assert.deepEqual(await plain.client().sessions.changes("ak-a", "s1", 5000), MIXED);
  });
});

describe("a session's changes, what the call is", () => {
  it("the call is a get with the caller's key and its own short timeout", async () => {
    const wire = new Wire(() => json(200, MIXED));
    await wire.client().sessions.changes("ak-a", "sess-7", 5000);
    const [request] = wire.sent;
    assert.ok(request);
    assert.deepEqual(
      [request.method, request.rawPath, request.headers.get("authorization")],
      ["GET", "/v1/sessions/sess-7/changes", "Bearer ak-a"],
    );
    const silent = new Wire(
      (sent) =>
        new Promise<Response>((_, reject) => {
          sent.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        }),
    );
    const started = performance.now();
    await assert.rejects(silent.client().sessions.changes("ak-a", "s1", 100), {
      name: "ClawUnreachable",
      kind: "timeout",
    });
    assert.ok(performance.now() - started < 5000);
  });

  const nothing: Array<[string, () => Response, (err: unknown) => boolean]> = [
    [
      "a sandbox that is gone",
      () => json(409, { ok: false, error: "sandbox_not_running" }),
      (e) => e instanceof ClawError && e.status === 409,
    ],
    [
      "a session Claw does not know",
      () => json(404, { ok: false, error: "not_found" }),
      (e) => e instanceof ClawError && e.status === 404,
    ],
    ["a gateway's page", () => new Response("<html>gateway</html>"), (e) => e instanceof ClawAnswerInvalid],
    ["a bare 502", () => new Response(null, { status: 502 }), (e) => e instanceof ClawError && e.status === 502],
  ];
  for (const [what, answer, expected] of nothing) {
    it(`what Claw answers when there is nothing to show is an error the reader can tell: ${what}`, async () => {
      await assert.rejects(new Wire(answer).client().sessions.changes("ak-a", "s1", 5000), expected);
    });
  }

  it("a reply of another shape is handed back as Claw wrote it, for the reader to refuse", async () => {
    const wire = new Wire(() => json(200, { ok: true, repos: "none" }));
    assert.deepEqual(await wire.client().sessions.changes("ak-a", "s1", 5000), { ok: true, repos: "none" });
  });
});
