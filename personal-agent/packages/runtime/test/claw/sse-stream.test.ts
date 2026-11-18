// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawError, ClawUnreachable, type SseEvent } from "@primusclaw/personal-agent";
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
    const early = new Wire(() => new Response("", { headers: { "content-type": "text/event-stream" } }));
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await all(early.client().sessions.stream("ak-a", "s1", undefined, aborted.signal)), []);
    assert.deepEqual(early.sent, []);
    const bodiless = new Wire(() => new Response(null, { status: 204 }));
    assert.deepEqual(await all(bodiless.client().sessions.stream("ak-a", "s1")), []);
  });
});

describe("a Claw event stream that is open", () => {
  it("says it is open once Claw answered, before its first event, and not when Claw refused it", async () => {
    const seen: string[] = [];
    const ok = new Wire(() => {
      seen.push("answered");
      return new Response('data: {"type":"a"}\n\n');
    });
    for await (const event of createClawClient({
      baseUrl: "https://claw.test",
      clock: new FakeClock(),
      fetch: ok.fetch,
    }).sessions.stream("ak-a", "s-1", "claw-1", undefined, () => seen.push("open")))
      seen.push(event.name);
    assert.deepEqual(seen, ["answered", "open", "a"]);
    const opened: string[] = [];
    const refused = new Wire(() => new Response("no", { status: 404 }));
    const err = await (async () => {
      for await (const event of createClawClient({
        baseUrl: "https://claw.test",
        clock: new FakeClock(),
        fetch: refused.fetch,
      }).sessions.stream("ak-a", "s-1", undefined, undefined, () => opened.push("open")))
        opened.push(event.name);
    })().catch((e: unknown) => e);
    assert.ok(err instanceof ClawError);
    assert.deepEqual(opened, []);
  });
});
