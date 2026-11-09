// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawUnreachable, type SseEvent } from "@primusclaw/personal-agent";
import { createClawClient } from "../../src/index.js";
import { sseEvents } from "../../src/claw/sse-stream.js";
import { ClawHttp } from "../../src/claw/http.js";
import { FakeClock, json, Wire } from "./wire.js";

/** A body that sends `chunks` and then, unless `end`, stays open. */
function body(chunks: string[], end = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (end) controller.close();
    },
  });
}

async function all(events: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("a Claw event stream", () => {
  it("history then live events, asked for after the last one seen", async () => {
    const wire = new Wire(
      () =>
        new Response(
          body([
            'id: 1\nevent: chatDelta\ndata: {"text":"a"}\n\n',
            'event: historyComplete\ndata: {"type":"historyComplete"}\n\n',
          ]),
        ),
    );
    const events = await all(wire.client().sessions.stream("ak-a", "s1", "e 0"));
    assert.deepEqual(
      events.map((e) => e.name),
      ["chatDelta", "historyComplete"],
    );
    const [sent] = wire.sent;
    assert.ok(sent);
    assert.equal(sent.headers.get("accept"), "text/event-stream");
    assert.equal(sent.url.searchParams.get("after"), "e 0");
    await all(wire.client().remoteAgents.stream("ak-a", "rs1", ""));
    assert.equal(wire.sent[1]?.url.search, "");
    assert.equal(wire.sent.at(1)?.rawPath ?? "", "/v1/remote-agents/sessions/rs1/events");
  });

  it("an error status is a ClawError, read before any event", async () => {
    const wire = new Wire(() => json(403, { ok: false, error: "access_denied" }));
    await assert.rejects(all(wire.client().sessions.stream("ak-a", "s1")), { name: "ClawError", status: 403 });
  });
});

describe("a Claw event stream that ends badly", () => {
  it("a stream silent past its idle limit is dropped as a timeout", async () => {
    const wire = new Wire(
      (sent) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
              sent.signal?.addEventListener("abort", () => {
                controller.error(new DOMException("aborted", "AbortError"));
              });
            },
          }),
        ),
    );
    const http = new ClawHttp("https://claw.test", wire.fetch);
    const seen: string[] = [];
    const err = await (async () => {
      for await (const event of sseEvents(http, "/v1/x", "ak-a", undefined, undefined, { idleMs: 30 }))
        seen.push(event.name);
    })().catch((e: unknown) => e);
    assert.deepEqual(seen, ["a"]);
    assert.ok(err instanceof ClawUnreachable);
    assert.equal(err.kind, "timeout");
  });

  it("the caller ends it with a signal; a broken connection is network", async () => {
    const controller = new AbortController();
    const wire = new Wire(
      (sent) =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
              sent.signal?.addEventListener("abort", () => {
                stream.error(new TypeError("terminated"));
              });
            },
          }),
        ),
    );
    const claw = createClawClient({ baseUrl: "https://claw.test", clock: new FakeClock(), fetch: wire.fetch });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const event of claw.sessions.stream("ak-a", "s1", undefined, controller.signal)) {
        seen.push(event.name);
        controller.abort();
      }
    })().catch((e: unknown) => e);
    assert.deepEqual(seen, ["a"]);
    assert.ok(err instanceof ClawUnreachable);
    assert.equal(err.kind, "network");
    const bodiless = new Wire(() => new Response(null, { status: 204 }));
    assert.deepEqual(await all(bodiless.client().sessions.stream("ak-a", "s1")), []);
  });
});
