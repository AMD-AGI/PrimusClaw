// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker as the release gate's external driver reaches it: activities in over HTTP on the loopback, everything out to
 * the recording Bot Connector and nowhere else (the made-up token never leaves for another host, and what the connector does
 * not take is dropped, never queued), with Teams' stream rules applied by the connector.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { err, neutralPlugins, ok, textMessage, type Clock } from "@primusclaw/personal-agent";
import { buildServer, listen, systemClock } from "@primusclaw/personal-agent-runtime";

import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { RecordingConnector } from "../../../../test-support/recording-connector.js";
import { openTestStore } from "../../../../test-support/store.js";
import { referenceOf } from "../../src/activity/outbound.js";
import type { JsonObject } from "../../src/cards/json.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { onlyConnector } from "../../src/connector/hosts.js";
import { ConnectorOutbox } from "../../src/connector/outbox.js";
import { gateRoutes, type GateEntryDeps } from "../../src/gate/routes.js";
import { GateToken, NoQueue } from "../../src/gate/no-queue.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import { noMasking } from "../../src/messenger/masker.js";
import { TeamsSurface } from "../../src/surface.js";
import { RENDERERS } from "../../src/views/index.js";

async function world(clock: Clock = new FakeClock()) {
  const connector = await RecordingConnector.start();
  const { store } = openTestStore();
  const outbox = new ConnectorOutbox({
    tokens: new GateToken("run-1"),
    fallback: new NoQueue(),
    clock,
    policy: onlyConnector(connector.url),
  });
  const surface = new TeamsSurface({
    mode: "direct",
    outbox,
    acks: new AckRegistry(clock),
    clock,
    random: new SeededRandom(3),
    style: DEFAULT_STYLE,
    renderers: RENDERERS,
    masker: noMasking,
    files: { fetchFile: () => Promise.resolve(err({ kind: "file_refused", reason: "none" })) },
  });
  return { connector, clock, store, outbox, surface };
}

function activity(serviceUrl: string, text: string): JsonObject {
  return {
    type: "message",
    id: "m-1",
    text,
    serviceUrl,
    channelId: "msteams",
    from: { id: "29:a", aadObjectId: "aad-a", name: "Lin Mei" },
    recipient: { id: "28:bot" },
    conversation: { id: "a:1on1", conversationType: "personal", tenantId: "t" },
  };
}

test("a message posted to the test entry is handled, and the answer reaches the recording connector", async () => {
  const { connector, store, surface } = await world();
  const handled: JsonObject[] = [];
  const deps: GateEntryDeps = {
    async handle(body) {
      handled.push(body);
      const wire = referenceOf(body);
      await surface.conversation({ id: "a:1on1", kind: "personal", tenantId: "t", wire }).send(textMessage("pong"));
    },
    links: store.links,
    members: store.members,
    notifySubs: store.notifySubs,
    sessions: store.sessions,
    exchange: neutralPlugins().tokenExchange,
    subscriptions: undefined,
    madeSessions: () => ["s-1"],
  };
  const app = buildServer({ routes: gateRoutes(deps), maxBodyBytes: 4 * 1024 * 1024 });
  const port = await listen(app, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${String(port)}/gate/v1`;
  try {
    const r = await fetch(`${base}/activity`, {
      method: "POST",
      body: JSON.stringify(activity(`${connector.url}/`, "ping")),
    });
    assert.deepEqual([r.status, await r.json()], [200, { status: "handled" }]);
    assert.equal(handled.length, 1);
    assert.deepEqual(connector.recorder.texts("a:1on1"), ["pong"]);
    const sent = connector.server.requests.find((q) => q.method === "POST");
    assert.equal(sent?.headers["authorization"], "Bearer release-gate-run-1-not-a-token");
    assert.deepEqual((await (await fetch(`${base}/sessions`)).json()) as unknown, { created: ["s-1"] });
    const bad = await fetch(`${base}/activity`, { method: "POST", body: "[1]" });
    assert.deepEqual([bad.status, await bad.json()], [400, { error: "not_an_activity" }]);
  } finally {
    await app.close();
    await connector.close();
  }
});

test("the made-up token goes to the recording connector only: any other serviceUrl is dropped, never queued", async () => {
  const { connector, surface } = await world();
  try {
    const elsewhere = referenceOf(activity("https://smba.trafficmanager.net/emea/", "x"));
    await surface
      .conversation({ id: "a:1on1", kind: "personal", tenantId: "t", wire: elsewhere })
      .send(textMessage("x"));
    assert.deepEqual(connector.server.requests, []);
  } finally {
    await connector.close();
  }
});

test("the gate links its made-up people, reads their state and their sessions", async () => {
  const { connector, store } = await world();
  const exchange = { ...neutralPlugins().tokenExchange, enabled: true, tokenFor: () => Promise.resolve(ok("t")) };
  const deps: GateEntryDeps = {
    handle: () => Promise.resolve(),
    links: store.links,
    members: store.members,
    notifySubs: store.notifySubs,
    sessions: store.sessions,
    exchange,
    subscriptions: {
      ensure: (aad) => {
        store.notifySubs.saveNotifySub(aad, { route: "r", subscriptionId: "sub-1", secret: "s" });
        return Promise.resolve();
      },
      remove: (aad) => {
        store.notifySubs.forgetNotifySub(aad);
        return Promise.resolve();
      },
      hasAssistantTypes: () => true,
    },
    madeSessions: () => [],
  };
  const app = buildServer({ routes: gateRoutes(deps), maxBodyBytes: 1024 * 1024 });
  const base = `http://127.0.0.1:${String(await listen(app, "127.0.0.1", 0))}/gate/v1/people`;
  try {
    const put = (aad: string, body: unknown) => fetch(`${base}/${aad}`, { method: "PUT", body: JSON.stringify(body) });
    const linked = await put("AAD-G", {
      name: "Gate Person",
      key: "ak-gate",
      claw_user_id: "u-gate",
      subscribe: false,
    });
    assert.deepEqual([linked.status, await linked.json()], [200, { status: "linked" }]);
    assert.equal(store.links.getKey("aad-g"), "ak-gate");
    assert.equal(store.links.clawUserIdOf("aad-g"), "u-gate");
    assert.equal(store.notifySubs.claimNotifyAttempt("aad-g", 1), false); // (no subscription of its own for a day)
    assert.equal((await put("aad-x", { name: "x" })).status, 400);
    const state: unknown = await (await fetch(`${base}/aad-g?scope=group:1`)).json();
    assert.deepEqual(state, { session_id: null, signed_in: true, subscription: null });
    const made: unknown = await (await fetch(`${base}/aad-g/subscription`, { method: "POST" })).json();
    assert.deepEqual(made, { session_id: null, signed_in: true, subscription: { id: "sub-1", assistant_types: true } });
    const removed: unknown = await (await fetch(`${base}/aad-g/subscription`, { method: "DELETE" })).json();
    assert.deepEqual(removed, { removed: "sub-1" });
    assert.equal(store.notifySubs.getNotifySub("aad-g"), null);
  } finally {
    await app.close();
    await connector.close();
  }
});

test("a stream through the recording connector keeps Teams' rules", async () => {
  // (real time: the connector answers over the network, and the stream waits out Teams' second between its requests)
  const { connector, surface } = await world(systemClock);
  try {
    const wire = referenceOf(activity(`${connector.url}/`, "x"));
    const opened = await surface
      .conversation({ id: "a:1on1", kind: "personal", tenantId: "t", wire })
      .openStream("m-1", "…");
    assert.ok(opened.ok);
    assert.ok((await opened.value.finish(textMessage("All green"))).ok);
    assert.deepEqual(
      connector.recorder.refusals.filter((r) => !r.why.includes("one request a second")),
      [],
    );
    assert.deepEqual(
      connector.recorder.records.map((r) => [r.op, r.activityId]),
      [
        ["stream", "gate-msg-1"],
        ["stream", "gate-msg-1"],
      ],
    );
  } finally {
    await connector.close();
  }
});
