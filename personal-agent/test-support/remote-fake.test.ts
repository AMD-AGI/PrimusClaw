// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The fake remote-agents server keeps Claw's contract: owner isolation, refusals, idempotency, and the event stream's frames.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { CODEX_OPTIONS, FakeRemote } from "./remote-fake.js";

const srv = new FakeRemote();
before(async () => {
  await srv.start();
});
after(async () => {
  await srv.stop();
});

const call = async (
  method: string,
  path: string,
  key = "ak-alice",
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`${srv.url}/v1/remote-agents${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

test("a session is the owner's alone and refusals carry Claw's error words", async () => {
  const cid = srv.addConnector("u-alice", "dev-pod", [
    ["codex", "codex", "Codex"],
  ]);
  const created = await call("POST", "/sessions", "ak-alice", {
    connector_id: cid,
    agent_id: "codex",
    cwd: "/repo",
  });
  assert.equal(created.status, 201);
  const sid = String((created.body.data as Record<string, unknown>).session_id);
  assert.equal((await call("GET", `/sessions/${sid}`, "ak-bob")).status, 404);
  assert.deepEqual((await call("GET", "/connectors", "ak-bob")).body.data, []);
  assert.equal((await call("GET", "/connectors", "nobody")).status, 401);
  assert.deepEqual(
    (
      await call("POST", "/sessions", "ak-alice", {
        connector_id: cid,
        agent_id: "x",
      })
    ).body,
    {
      ok: false,
      error: "agent_not_found",
    },
  );
  srv.connector(cid).online = false;
  assert.equal(
    (
      await call("POST", `/sessions/${sid}/commands`, "ak-alice", {
        type: "prompt",
        text: "hi",
      })
    ).body.error,
    "connector_offline",
  );
  srv.connector(cid).online = true;
  const first = await call(
    "POST",
    `/sessions/${sid}/commands`,
    "ak-alice",
    { type: "prompt", text: "hi" },
    { "Idempotency-Key": "k1" },
  );
  const again = await call(
    "POST",
    `/sessions/${sid}/commands`,
    "ak-alice",
    { type: "prompt", text: "hi" },
    { "Idempotency-Key": "k1" },
  );
  assert.equal(first.status, 202);
  assert.deepEqual(again.body.data, { cmd_id: "k:k1", duplicate: true });
  assert.equal(srv.commandsOf("prompt").length, 1);
  await srv.ask(sid, "a1", "Bash", CODEX_OPTIONS);
  assert.equal(
    (
      await call("POST", `/sessions/${sid}/decisions`, "ak-alice", {
        action_id: "a1",
        option_id: "nope",
      })
    ).body.error,
    "unknown_option",
  );
  assert.equal(
    (
      await call("POST", `/sessions/${sid}/decisions`, "ak-alice", {
        action_id: "a1",
        option_id: "cancel",
      })
    ).status,
    202,
  );
  srv.failOn("GET", "/sessions", [503, "busy"]);
  assert.deepEqual((await call("GET", "/sessions")).body, {
    ok: false,
    error: "busy",
  });
  srv.fail.clear();
});

test("the event stream replays after a cursor, marks the history and goes on live", async () => {
  const cid = srv.addConnector("u-alice", "box", [["codex", "codex", "Codex"]]);
  const sid = srv.addSession("u-alice", cid, "codex");
  const firstId = await srv.say(sid, "one");
  await srv.say(sid, "two");
  const res = await fetch(
    `${srv.url}/v1/remote-agents/sessions/${sid}/events?after=${String(firstId)}`,
    {
      headers: { Authorization: "Bearer ak-alice" },
    },
  );
  const reader = res.body?.getReader();
  assert.ok(reader);
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("historyComplete"))
    text += decoder.decode((await reader.read()).value);
  assert.ok(
    !text.includes('"one"') &&
      text.includes('"two"') &&
      text.includes("event: agent_message_chunk"),
  );
  await srv.end(sid);
  while (!text.includes("turn_end"))
    text += decoder.decode((await reader.read()).value);
  await reader.cancel();
  const replay = await call(
    "GET",
    `/sessions/${sid}/events?mode=replay&after=0&limit=2`,
  );
  assert.equal((replay.body.data as unknown[]).length, 2);
});
