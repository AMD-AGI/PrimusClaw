// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What Claw lists of remote agents is read tolerantly: a missing or mistyped field is "not said", never a failure.
import assert from "node:assert/strict";
import { test } from "node:test";

import { groupChatKey, isGroupKey, personOf } from "../../src/remote/chat-key.js";
import { agentById, connectorById, connectorFrom, sessionFrom } from "../../src/remote/model.js";
import { remoteConnectorsSchema, remoteSessionsSchema } from "../../src/claw/remote.js";

/** A reading without the answer it was read from (and its agents too). */
function withoutRaw<T extends { raw: unknown }>(reading: T): Omit<T, "raw"> {
  const rest: Record<string, unknown> = { ...reading };
  delete rest.raw;
  if (Array.isArray(rest.agents)) rest.agents = (rest.agents as { raw: unknown }[]).map(withoutRaw);
  return rest as Omit<T, "raw">;
}

test("a connector is read with its agents and every field it did not say is empty", () => {
  const listed = remoteConnectorsSchema.parse([
    {
      connector_id: "c1",
      name: "dev-pod",
      online: true,
      version: "0.1.4",
      version_status: "current",
      last_seen_at: "2026-11-09T12:00:00Z",
      paired: true,
      agents: [{ agent_id: "codex", kind: "codex", name: "Codex", capabilities: { roots: ["/repo"] } }, "junk"],
    },
    { connector_id: 7, online: "yes", agents: "none", heartbeat_at: "2026-11-09T11:00:00Z" },
    "not a connector",
    null,
  ]);
  assert.equal(listed.length, 2);
  const [connector, bare] = listed.map(connectorFrom).map(withoutRaw);
  assert.deepEqual(connector, {
    connectorId: "c1",
    name: "dev-pod",
    online: true,
    version: "0.1.4",
    versionStatus: "current",
    lastSeenAt: "2026-11-09T12:00:00Z",
    heartbeatAt: "",
    paired: true,
    agents: [{ agentId: "codex", kind: "codex", name: "Codex", capabilities: { roots: ["/repo"] } }],
  });
  assert.deepEqual(bare, {
    connectorId: "", // (an id of another type than text is no id)
    name: "",
    online: false,
    version: "",
    versionStatus: "",
    lastSeenAt: "",
    heartbeatAt: "2026-11-09T11:00:00Z",
    paired: false,
    agents: [],
  });
  assert.equal(connectorById(listed.map(connectorFrom), "c1")?.raw, listed[0]);
  assert.equal(agentById(connectorFrom(listed[0] ?? {}), "codex")?.name, "Codex");
  assert.equal(agentById(undefined, "codex"), undefined);
});

test("a session is read with its flags as said or null", () => {
  const sessions = remoteSessionsSchema.parse([
    {
      session_id: "s1",
      connector_id: "c1",
      agent_id: "codex",
      cwd: "/repo",
      status: "active",
      mode: null,
      read_only: true,
      connector_online: false,
      created_at: "2026-10-29T06:00:00.000Z",
      updated_at: "2026-10-29T06:00:01.000Z",
    },
    [],
  ]);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions.map(sessionFrom).map(withoutRaw)[0], {
    sessionId: "s1",
    connectorId: "c1",
    agentId: "codex",
    cwd: "/repo",
    status: "active",
    readOnly: true,
    updatedAt: "2026-10-29T06:00:01.000Z",
  });
  assert.equal(sessionFrom({ session_id: "s2" }).readOnly, null);
});

test("a group binding's chat key names its binder and the group, a 1:1 chat's is the person", () => {
  const key = groupChatKey("aad-a", "19:group@thread.v2");
  assert.equal(key, "aad-a#19:group@thread.v2");
  assert.equal(personOf(key), "aad-a");
  assert.equal(personOf("aad-a"), "aad-a");
  assert.ok(isGroupKey(key) && !isGroupKey("aad-a"));
});

test("an agent that reports no capabilities has none", () => {
  const [connector] = remoteConnectorsSchema
    .parse([{ connector_id: "c", agents: [{ agent_id: "a" }] }])
    .map(connectorFrom);
  assert.deepEqual(connector?.agents.map(withoutRaw), [{ agentId: "a", kind: "", name: "", capabilities: {} }]);
});
