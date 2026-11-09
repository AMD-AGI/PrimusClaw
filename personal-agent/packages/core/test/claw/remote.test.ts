// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  remoteConnectorsSchema,
  remoteEventRowsSchema,
  remotePairingSchema,
  remoteSessionSchema,
  remoteSessionsSchema,
} from "../../src/index.js";

describe("remote-agents answers", () => {
  it("reads connectors and their agents, a field of the wrong type as absent", () => {
    const rows = remoteConnectorsSchema.parse([
      {
        connector_id: "c1",
        name: "laptop",
        online: true,
        version: "0.1.4",
        agents: [{ agent_id: "a1", kind: "claude", name: "Claude", capabilities: { unattended: true } }, "junk"],
      },
      "not a row",
      { connector_id: 5, online: "yes", agents: "none" },
    ]);
    assert.equal(rows.length, 2);
    const [laptop, broken] = rows;
    assert.deepEqual(
      laptop?.agents?.map((a) => a.agent_id),
      ["a1"],
    );
    assert.equal(broken?.connector_id, undefined);
    assert.equal(broken?.online, undefined);
    assert.equal(broken?.agents, undefined);
  });

  it("keeps fields it does not read", () => {
    const session = remoteSessionSchema.parse({
      session_id: "s1",
      status: "running",
      read_only: false,
      updated_at: "2026-11-09T12:00:00.000Z",
      extra: 1,
    });
    assert.equal(session.updated_at, "2026-11-09T12:00:00.000Z");
    assert.equal(session.session_id, "s1");
    assert.equal(session.read_only, false);
    assert.equal(session["extra"], 1);
    assert.equal(remoteSessionsSchema.parse([{ cwd: 3 }])[0]?.cwd, undefined);
  });

  it("reads event rows with a numeric or text id", () => {
    const rows = remoteEventRowsSchema.parse([
      { id: 12, seq: 3, type: "chatDelta", ts: 1_762_000_000_123, data: { text: "x" } },
      { id: "e2", ts: "1762000000456", data: [] },
      { id: "e3", ts: "yesterday" },
    ]);
    const [numbered, named] = rows;
    assert.ok(numbered && named);
    assert.equal(numbered.id, "12");
    assert.deepEqual(numbered.data, { text: "x" });
    assert.equal(named.id, "e2");
    assert.equal(named.data, undefined);
    assert.equal(numbered.ts, 1_762_000_000_123);
    assert.equal(named.ts, 1_762_000_000_456);
    assert.equal(rows[2]?.ts, undefined);
  });

  it("reads a pairing", () => {
    const pairing = remotePairingSchema.parse({ code: "X", expires_in: 600, command: "npx ..." });
    assert.equal(pairing.expires_in, 600);
    assert.equal(pairing.server, undefined);
  });
});
