// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// anthropic-provider-cache-body.test.ts
//
// The first test in this repo that reads the request body Brain actually
// sends. That absence is the whole incident: `x-auto-prompt-caching: true`
// sat in the client headers for two years reading, in the diff and to every
// reviewer after, as "prompt caching is on", while not one request ever
// carried a cache breakpoint. Nothing could have caught that -- the loop's
// own session seam sits above the provider and never sees a body.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import { anthropicDefaultHeaders, buildAnthropicSession } from "../src/llm/anthropic-provider.js";

type Body = Record<string, any>;

/** A minimal well-formed stream: enough events for streamingTurn to finish. */
function fakeStream(usage: Record<string, unknown> = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "message_start",
        message: { model: "claude-sonnet-5", usage: { input_tokens: 7, ...usage } },
      };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } };
      yield { type: "message_stop" };
    },
  };
}

/** Records every body handed to messages.create; `fail` throws on the Nth call. */
function stubClient(opts: { failUntil?: number; error?: unknown; usage?: Record<string, unknown> } = {}) {
  const bodies: Body[] = [];
  const client = {
    messages: {
      create: async (body: Body) => {
        bodies.push(structuredClone(body));
        if (opts.failUntil && bodies.length <= opts.failUntil) {
          throw opts.error ?? new Error("boom");
        }
        return fakeStream(opts.usage);
      },
    },
  };
  return { client: client as any, bodies };
}

const TOOLS: ToolSchema[] = [{ name: "bash", description: "run", input_schema: { type: "object" } }];
function convo(): Message[] {
  return [
    { role: "user", content: "the task prompt ".repeat(20) },
    { role: "assistant", content: [{ type: "tool_use", id: "c0", name: "bash", input: { command: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", content: "ok" }] },
  ];
}

function markersIn(body: Body): number {
  let n = 0;
  const walk = (blocks: any) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) if (b && typeof b === "object" && b.cache_control) n++;
  };
  walk(body.system);
  for (const m of body.messages ?? []) walk(m.content);
  return n;
}

test("the request body that goes out carries cache breakpoints", async () => {
  const { client, bodies } = stubClient();
  const session = buildAnthropicSession(client, "claude-sonnet-5");
  const res = await session.streamTurn(convo(), TOOLS, undefined);

  assert.equal(bodies.length, 1);
  const sent = markersIn(bodies[0]);
  assert.ok(sent > 0, "no cache_control reached the wire -- this is the incident");
  assert.ok(sent <= 4, `sent ${sent} markers, over the API cap`);
  assert.equal(res.cacheReport?.breakpointsSent, sent, "the report must match the bytes");
  assert.equal(res.cacheReport?.enabled, true);
  assert.deepEqual([...(res.cacheReport?.reported ?? [])], ["cache_read", "cache_create"]);
});

test("no system parameter is sent when the conversation has no system message", async () => {
  const { client, bodies } = stubClient();
  await buildAnthropicSession(client, "claude-sonnet-5").streamTurn(convo(), TOOLS, undefined);
  assert.equal(bodies[0].system, undefined);
  assert.equal(bodies[0].messages[0].role, "user");
});

test("a leading system message is hoisted out of messages[] into the system parameter", async () => {
  // The Messages API has no "system" role. Sending one has been working only
  // because the gateway rewrites it.
  const { client, bodies } = stubClient();
  const msgs: Message[] = [{ role: "system", content: "be terse" }, ...convo()];
  await buildAnthropicSession(client, "claude-sonnet-5").streamTurn(msgs, TOOLS, undefined);
  assert.ok(Array.isArray(bodies[0].system));
  assert.equal(bodies[0].messages.some((m: Body) => m.role === "system"), false);
});

test("the caller's messages are not mutated by sending them", async () => {
  const { client } = stubClient();
  const msgs = convo();
  const before = JSON.stringify(msgs);
  await buildAnthropicSession(client, "claude-sonnet-5").streamTurn(msgs, TOOLS, undefined);
  assert.equal(JSON.stringify(msgs), before, "workingMessages was mutated and would be checkpointed");
});

test("a cache-shaped rejection retries the same turn undecorated and latches", async () => {
  // Deliberately a 503, not a 400. This gateway re-wraps upstream failures as
  // 5xx and 401, all of which the loop's retry ladder treats as transient --
  // so a status-gated latch would never arm while the loop re-sent the same
  // rejected body up to twelve times a turn.
  const err: any = new Error("cache_control: unsupported field");
  err.status = 503;
  const { client, bodies } = stubClient({ failUntil: 1, error: err });
  const session = buildAnthropicSession(client, "claude-sonnet-5");

  const first = await session.streamTurn(convo(), TOOLS, undefined);
  assert.equal(bodies.length, 2, "expected one undecorated retry");
  assert.ok(markersIn(bodies[0]) > 0);
  assert.equal(markersIn(bodies[1]), 0, "the retry must drop every marker");
  assert.equal(first.cacheReport?.breakpointsSent, 0);
  assert.equal(first.cacheReport?.enabled, false);

  // and the rest of the session stops paying for markers
  const second = await session.streamTurn(convo(), TOOLS, undefined);
  assert.equal(markersIn(bodies[2]), 0, "the latch must hold for the session");
  assert.equal(second.cacheReport?.enabled, false);
});

test("an unrelated failure does not disable caching", async () => {
  const err: any = new Error("Internal server error");
  err.status = 500;
  const { client, bodies } = stubClient({ failUntil: 1, error: err });
  const session = buildAnthropicSession(client, "claude-sonnet-5");

  await assert.rejects(() => session.streamTurn(convo(), TOOLS, undefined), /Internal server error/);
  assert.equal(bodies.length, 1, "a plain 500 must not trigger the undecorated retry");

  const ok = await session.streamTurn(convo(), TOOLS, undefined);
  assert.equal(ok.cacheReport?.enabled, true, "one transient failure must not cost the session its cache");
  assert.ok(markersIn(bodies[1]) > 0);
});

test("a second consecutive decorated failure is tested by dropping the markers", async () => {
  // The second arming condition: not "the error said cache", but "twice in a
  // row while decorated". It is settled by actually sending the bare request
  // and seeing whether it goes through.
  const err: any = new Error("Bad Gateway");
  err.status = 502;
  const { client, bodies } = stubClient({ failUntil: 2, error: err });
  const session = buildAnthropicSession(client, "claude-sonnet-5");

  await assert.rejects(() => session.streamTurn(convo(), TOOLS, undefined));
  assert.equal(bodies.length, 1);

  const res = await session.streamTurn(convo(), TOOLS, undefined);
  assert.equal(bodies.length, 3, "decorated attempt, then the bare retry");
  assert.ok(markersIn(bodies[1]) > 0);
  assert.equal(markersIn(bodies[2]), 0);
  assert.equal(res.cacheReport?.enabled, false);
});

test("when the bare retry fails too, the markers were not the problem and stay on", async () => {
  // A flaky gateway must not cost the session its cache permanently. The bare
  // probe is the experiment: if the request fails WITHOUT markers as well,
  // the markers were not the cause and the latch must not arm.
  const err: any = new Error("cache_control exploded");
  err.status = 503;
  const { client, bodies } = stubClient({ failUntil: 2, error: err });
  const session = buildAnthropicSession(client, "claude-sonnet-5");

  await assert.rejects(() => session.streamTurn(convo(), TOOLS, undefined));
  assert.equal(bodies.length, 2, "decorated attempt plus the bare probe");
  assert.ok(markersIn(bodies[0]) > 0);
  assert.equal(markersIn(bodies[1]), 0);

  // Same session, next turn: still decorated.
  const ok = await session.streamTurn(convo(), TOOLS, undefined);
  assert.equal(ok.cacheReport?.enabled, true, "the latch must not have armed");
  assert.ok(markersIn(bodies[2]) > 0, "the session must still be sending markers");
});

test("the ephemeral write split is reported so a silent TTL downgrade is visible", async () => {
  // A 1h marker answered with a 5m write is a 200 OK failure: the request
  // succeeds, the cache works, and it expires under the sleep it was chosen
  // to outlast.
  const { client } = stubClient({
    usage: {
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
    },
  });
  const res = await buildAnthropicSession(client, "claude-sonnet-5").streamTurn(convo(), TOOLS, undefined);
  assert.equal(res.cacheReport?.createdEphemeral5m, 900);
  assert.equal(res.cacheReport?.createdEphemeral1h, 0);
});

test("complete() sends no markers and no tools", async () => {
  // The compaction summariser: one shot, no reusable prefix. A breakpoint
  // there bills the write premium for an entry nothing ever reads.
  const { client, bodies } = stubClient();
  const session = buildAnthropicSession(client, "claude-sonnet-5");
  (client.messages as any).create = async (body: Body) => {
    bodies.push(structuredClone(body));
    return { content: [{ type: "text", text: "summary" }] };
  };
  await session.complete("sys", "user text", 100);
  assert.equal(markersIn(bodies[0]), 0);
  assert.equal(bodies[0].tools, undefined);
});

test("the dead x-auto-prompt-caching header is gone and stays gone", async () => {
  // Asserting an ABSENCE, on purpose. This header asked the gateway to choose
  // cache breakpoints on our behalf; the hook implementing it landed two
  // months later and has never fired. Now that Brain places its own markers,
  // a gateway hook that started working would add its own on top of ours --
  // and four is the hard cap, so the two together are a 400. Re-adding the
  // header is not a harmless no-op any more.
  const headers = anthropicDefaultHeaders({
    litellmTags: "t", litellmMeta: "{}", userId: "u", sessionId: "s",
  });
  assert.equal(
    Object.keys(headers).some((k) => k.toLowerCase() === "x-auto-prompt-caching"),
    false,
  );
  // The session-affinity header must stay: without it the Auto Router can
  // change backend mid-conversation, and cache entries are model-scoped.
  assert.equal(headers["x-litellm-session-id"], "s");
});

test("the system hoist survives caching being turned off", async () => {
  // The Messages API has no "system" role; leaving one in messages[] works
  // only because the gateway rewrites it. Hoisting is a correctness fix in its
  // own right, so turning caching off must not silently revert the request to
  // a shape the API does not accept.
  const err: any = new Error("cache_control rejected");
  err.status = 503;
  const { client, bodies } = stubClient({ failUntil: 1, error: err });
  const session = buildAnthropicSession(client, "claude-sonnet-5");
  const msgs: Message[] = [{ role: "system", content: "be terse" }, ...convo()];

  await session.streamTurn(msgs, TOOLS, undefined);       // latches
  await session.streamTurn(msgs, TOOLS, undefined);       // latched turn

  for (const [i, b] of bodies.entries()) {
    assert.ok(Array.isArray(b.system), `request ${i} lost the top-level system parameter`);
    assert.equal(
      b.messages.some((m: Body) => m.role === "system"), false,
      `request ${i} put role:"system" back into messages[]`,
    );
  }
  assert.equal(markersIn(bodies[bodies.length - 1]), 0, "and the latch still suppressed the markers");
});

test("the undecorated fallback gets its own abort controller", async () => {
  // The first-byte watchdog aborts the controller it watches. Sharing one
  // across attempts means the fallback inherits an aborted signal and fails
  // instantly, so the probe that decides whether the markers were the problem
  // never actually runs.
  const seen: Array<AbortSignal | undefined> = [];
  const bodies: Body[] = [];
  let n = 0;
  const client = {
    messages: {
      create: async (body: Body, opts?: { signal?: AbortSignal }) => {
        bodies.push(structuredClone(body));
        seen.push(opts?.signal);
        if (++n === 1) {
          // Abort exactly as the first-byte watchdog would, then fail.
          const e: any = new Error("cache_control: stream first-byte timeout");
          e.status = 503;
          throw e;
        }
        return fakeStream();
      },
    },
  } as any;

  const res = await buildAnthropicSession(client, "claude-sonnet-5")
    .streamTurn(convo(), TOOLS, undefined);

  assert.equal(bodies.length, 2, "the fallback must actually have been sent");
  assert.notEqual(seen[0], seen[1], "the second attempt reused the first attempt's signal");
  assert.equal(seen[1]?.aborted, false, "the fallback started from an already-aborted signal");
  assert.equal(res.cacheReport?.enabled, false);
});

test("a failed probe keeps the evidence instead of discarding it", async () => {
  // If the bare probe fails too, the markers were probably not the cause and
  // the session keeps them -- but that attempt still failed while decorated,
  // so the counter must not be reset. Zeroing it leaves the latch permanently
  // one failure short of arming on a gateway that is both marker-hostile and
  // slow, which is the end state the status-gated design was rejected for.
  const err: any = new Error("Bad Gateway");
  err.status = 502;
  const { client, bodies } = stubClient({ failUntil: 4, error: err });
  const session = buildAnthropicSession(client, "claude-sonnet-5");

  await assert.rejects(() => session.streamTurn(convo(), TOOLS, undefined));
  assert.equal(bodies.length, 1, "first failure only counts, it does not probe");

  await assert.rejects(() => session.streamTurn(convo(), TOOLS, undefined));
  assert.equal(bodies.length, 3, "second failure probes; the probe fails too");

  // Third turn: the evidence survived, so this failure probes again rather
  // than starting the count over.
  const ok = await session.streamTurn(convo(), TOOLS, undefined);
  assert.equal(bodies.length, 5, "a reset counter would have skipped the probe here");
  assert.equal(markersIn(bodies[4]), 0);
  assert.equal(ok.cacheReport?.enabled, false, "and it latches");
});
