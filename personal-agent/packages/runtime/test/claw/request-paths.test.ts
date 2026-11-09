// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An id that reaches the Claw client can never change which host or endpoint a request goes to (CodeQL
 * js/request-forgery). Ids come from stored rows and from card actions a person can edit. Every request method of the
 * client is driven with each of its id arguments set to a hostile value: it either refuses it as ClawError(404) before
 * anything is sent, or sends the request to the same host and path as for a plain id, with the hostile value whole
 * inside the one segment (or query value) the plain id took.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawError, type ClawPort } from "@primusclaw/personal-agent";
import { json, Wire, type Sent } from "./wire.js";

const PLAIN = "ID0plain";
const HOSTILE = [
  "../admin",
  "..",
  ".",
  "a/b",
  "/v1/keys",
  "x?admin=1",
  "x#frag",
  "%2e%2e",
  "%2F",
  "",
  " ",
  "a b",
  "x\n",
  "x\r\nHost: evil",
  "@evil.example",
  "evil.example:443@",
  "http://evil.example/",
  "\\..\\x",
  "x;y",
  "‮",
  "x".repeat(201),
];

type Drive = (claw: ClawPort, id: string) => Promise<unknown>;

/** Reads the first event of a stream (the fake sends none) and stops. */
async function first(events: AsyncIterable<unknown>): Promise<void> {
  for await (const event of events) {
    void event;
    break;
  }
}

/** Every request method of the client that takes an id, by `<resource>.<method>:<argument>`. */
const CASES: Readonly<Record<string, Drive>> = {
  "sessions.uploadFiles:sessionId": (c, id) =>
    c.sessions.uploadFiles("k", id, "f", [{ name: "a.txt", content: new Uint8Array([120]), mediaType: "text/plain" }]),
  "sessions.setModel:sessionId": (c, id) => c.sessions.setModel("k", id, "m"),
  "sessions.sendMessage:sessionId": (c, id) => c.sessions.sendMessage("k", id, "hi"),
  "sessions.turn:sessionId": (c, id) => c.sessions.turn("k", id),
  "sessions.events:sessionId": (c, id) => c.sessions.events("k", id, { tail: 10, maxBytes: 65536 }),
  "sessions.lastEventId:sessionId": (c, id) => c.sessions.lastEventId("k", id),
  "sessions.changes:sessionId": (c, id) => c.sessions.changes("k", id, 5000),
  "sessions.interrupt:sessionId": (c, id) => c.sessions.interrupt("k", id),
  "sessions.decide:sessionId": (c, id) => c.sessions.decide("k", id, "tu1", "allow"),
  "sessions.decide:toolUseId": (c, id) => c.sessions.decide("k", "s1", id, "allow"),
  "sessions.answer:sessionId": (c, id) => c.sessions.answer("k", id, "tu1", {}, []),
  "sessions.answer:toolUseId": (c, id) => c.sessions.answer("k", "s1", id, {}, []),
  "sessions.vote:sessionId": (c, id) => c.sessions.vote("k", id, "m1", "up"),
  "sessions.vote:messageId": (c, id) => c.sessions.vote("k", "s1", id, "up"),
  "sessions.stream:sessionId": (c, id) => first(c.sessions.stream("k", id, "e1")),
  "sessions.stream:after": (c, id) => first(c.sessions.stream("k", "s1", id)),
  "workItems.get:itemId": (c, id) => c.workItems.get("k", id),
  "workItems.requesterView:itemId": (c, id) => c.workItems.requesterView("k", id),
  "workItems.accept:itemId": (c, id) => c.workItems.accept("k", id, 1),
  "workItems.retry:itemId": (c, id) => c.workItems.retry("k", id),
  "workItems.stop:itemId": (c, id) => c.workItems.stop("k", id),
  "workItems.pulls:itemId": (c, id) => c.workItems.pulls("k", id),
  "workItems.watchPull:itemId": (c, id) =>
    c.workItems.watchPull("exchanged-token", id, "https://github.com/o/r/pull/1"),
  "workItems.watches:itemId": (c, id) => c.workItems.watches("k", id),
  "workItems.unwatchPull:itemId": (c, id) => c.workItems.unwatchPull("k", id, "5"),
  "workItems.unwatchPull:subId": (c, id) => c.workItems.unwatchPull("k", "i1", id),
  "assistant.send:sessionId": (c, id) => c.assistant.send("k", id, "hi"),
  "assistant.decideConfirmation:confirmationId": (c, id) =>
    c.assistant.decideConfirmation("exchanged-token", id, "allow"),
  "assistant.observe:messageId": (c, id) => c.assistant.observe("k", "group:teams:19:c@thread.v2", "Alice: hi", id),
  "notifications.updateTypes:subscriptionId": (c, id) => c.notifications.updateTypes("k", id, []),
  "notifications.delete:subscriptionId": (c, id) => c.notifications.delete("k", id),
  "triggers.update:triggerId": (c, id) =>
    c.triggers.update("k", id, { name: "n", prompt: "p", schedule: "0 9 * * *", timezone: "UTC" }),
  "triggers.delete:triggerId": (c, id) => c.triggers.delete("k", id),
  "mergeConfirmations.pending:sessionId": (c, id) => c.mergeConfirmations.pending("k", id),
  "mergeConfirmations.decide:confirmationId": (c, id) => c.mergeConfirmations.decide("exchanged-token", id, "allow"),
  "remoteAgents.revoke:connectorId": (c, id) => c.remoteAgents.revoke("k", id),
  "remoteAgents.createSession:connectorId": (c, id) =>
    c.remoteAgents.createSession("k", { connectorId: id, agentId: "a1", cwd: "/" }),
  "remoteAgents.createSession:agentId": (c, id) =>
    c.remoteAgents.createSession("k", { connectorId: "c1", agentId: id, cwd: "/" }),
  "remoteAgents.session:sessionId": (c, id) => c.remoteAgents.session("k", id),
  "remoteAgents.command:sessionId": (c, id) => c.remoteAgents.command("k", id, { type: "prompt" }),
  "remoteAgents.decide:sessionId": (c, id) => c.remoteAgents.decide("k", id, "ac1", "op1"),
  "remoteAgents.decide:actionId": (c, id) => c.remoteAgents.decide("k", "s1", id, "op1"),
  "remoteAgents.decide:optionId": (c, id) => c.remoteAgents.decide("k", "s1", "ac1", id),
  "remoteAgents.events:sessionId": (c, id) => c.remoteAgents.events("k", id, "e1"),
  "remoteAgents.events:after": (c, id) => c.remoteAgents.events("k", "s1", id),
  "remoteAgents.stream:sessionId": (c, id) => first(c.remoteAgents.stream("k", id, "e1")),
  "remoteAgents.stream:after": (c, id) => first(c.remoteAgents.stream("k", "s1", id)),
};

/** The methods that take no id (or, `deliveryLink`, make no request), so that a new one has to be placed on purpose. */
const WITHOUT_ID = new Set([
  "sessions.checkKey",
  "sessions.create",
  "sessions.deliveryLink",
  "workItems.list",
  "workItems.askedOfOthers",
  "assistant.session",
  "assistant.brief",
  "assistant.startReviews",
  "assistant.observeScope",
  "assistant.observations",
  "settings.memory",
  "settings.setMemory",
  "settings.models",
  "settings.assistantSettings",
  "settings.reviewMode",
  "settings.setReviewMode",
  "settings.githubConnection",
  "notifications.list",
  "notifications.create",
  "triggers.list",
  "triggers.create",
  "remoteAgents.setup",
  "remoteAgents.connectors",
  "remoteAgents.pair",
  "remoteAgents.sessions",
]);

function answer(sent: Sent): Response {
  if (sent.headers.get("accept") === "text/event-stream") {
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return json(200, { data: {} });
}

async function drive(drive: Drive, id: string): Promise<{ sent: Sent[]; error: unknown }> {
  const wire = new Wire(answer);
  try {
    await drive(wire.client(), id);
  } catch (error) {
    return { sent: wire.sent, error };
  }
  return { sent: wire.sent, error: undefined };
}

function segments(sent: Sent): string[] {
  return sent.rawPath.split("/").map((s) => decodeURIComponent(s));
}

function methodsOf(claw: ClawPort): string[] {
  const out: string[] = [];
  for (const [resource, port] of Object.entries(claw)) {
    if (typeof port !== "object" || port === null) continue;
    const proto = Object.getPrototypeOf(port) as object;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const member: unknown = (port as Record<string, unknown>)[name];
      if (name !== "constructor" && typeof member === "function") out.push(`${resource}.${name}`);
    }
  }
  return out;
}

describe("Claw request paths", () => {
  it("every request method with an id is covered", () => {
    const covered = new Set(Object.keys(CASES).map((c) => c.split(":")[0]));
    const methods = methodsOf(new Wire().client());
    const placed = methods.filter((m) => !covered.has(m) && !WITHOUT_ID.has(m));
    assert.deepEqual(placed, [], "every public method is either driven here or listed as taking no id");
    assert.ok(Object.keys(CASES).length >= 30);
    for (const name of [
      "sessions.changes",
      "sessions.stream",
      "workItems.get",
      "workItems.accept",
      "remoteAgents.events",
    ]) {
      assert.ok(covered.has(name), name);
    }
  });

  for (const [name, call] of Object.entries(CASES)) {
    it(`an id cannot steer the host or the path: ${name}`, async () => {
      const plain = await drive(call, PLAIN);
      assert.ok(plain.sent.length > 0, `${name} sent nothing for a plain id`);
      for (const hostile of HOSTILE) {
        const { sent, error } = await drive(call, hostile);
        if (sent.length === 0) {
          assert.ok(
            error instanceof ClawError && error.status === 404,
            `${name} ${JSON.stringify(hostile)}: ${String(error)}`,
          );
          continue;
        }
        assert.equal(sent.length, plain.sent.length);
        plain.sent.forEach((p, i) => {
          const got = sent[i];
          assert.ok(got);
          assert.equal(got.url.protocol, "https:");
          assert.equal(got.url.host, "claw.test");
          assert.equal(got.method, p.method);
          const ps = segments(p);
          const gs = segments(got);
          assert.equal(gs.length, ps.length, `${name} ${JSON.stringify(hostile)}: ${got.rawPath}`);
          ps.forEach((seg, j) => {
            assert.equal(gs[j], seg === PLAIN ? hostile : seg);
            assert.ok(gs[j] !== "." && gs[j] !== "..");
          });
          const expected = [...p.url.searchParams].flatMap(([k, v]) =>
            v === PLAIN ? (name.endsWith(":after") && hostile === "" ? [] : [[k, hostile]]) : [[k, v]],
          );
          assert.deepEqual([...got.url.searchParams], expected);
        });
      }
    });
  }

  for (const plain of [
    "sess-1",
    "s1",
    "sess_1",
    "0b7e4c4e-58e1-4f50-9d39-0d7c3cbb3a1c",
    "a.b~c",
    "x".repeat(200),
    "42",
  ]) {
    it(`a real id goes into the path as written: ${plain.slice(0, 20)}`, async () => {
      const wire = new Wire(() => json(200, { data: { agent_status: "idle" } }));
      const claw = wire.client();
      await claw.sessions.turn("k", plain);
      await claw.triggers.delete("k", plain);
      assert.deepEqual(
        wire.sent.map((s) => s.rawPath),
        [`/v1/sessions/${plain}`, `/v1/triggers/${plain}`],
      );
    });
  }
});
