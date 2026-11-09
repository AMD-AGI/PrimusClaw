// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawAnswerInvalid } from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

describe("remote agents", () => {
  it("every call names this client in Claw's audit trail, configurable", async () => {
    const wire = new Wire(() => json(200, { data: [] }));
    await wire.client().remoteAgents.connectors("ak-a");
    await wire.client({ clientLabel: "my-agent" }).remoteAgents.sessions("ak-a");
    assert.deepEqual(
      wire.sent.map((s) => [s.rawPath, s.headers.get("x-claw-client")]),
      [
        ["/v1/remote-agents/connectors", "clawy"],
        ["/v1/remote-agents/sessions", "my-agent"],
      ],
    );
  });

  it("reads connectors, sessions, a pairing and the setup as Claw answers them", async () => {
    const wire = new Wire(() =>
      json(200, { data: [{ connector_id: "c1", online: true, agents: [{ agent_id: "a1", capabilities: { x: 1 } }] }] }),
    );
    const claw = wire.client();
    assert.equal((await claw.remoteAgents.connectors("ak-a"))[0]?.agents?.[0]?.agent_id, "a1");
    wire.answer = () => json(200, { data: { session_id: "rs1", status: "running" } });
    assert.equal((await claw.remoteAgents.session("ak-a", "rs1")).status, "running");
    wire.answer = () => json(200, { data: { code: "ABCD", expires_in: 600 } });
    assert.equal((await claw.remoteAgents.pair("ak-a")).code, "ABCD");
    assert.deepEqual(wire.sent.at(-1)?.body, {});
    wire.answer = () => json(200, { data: { package: "@primusclaw/connector" } });
    assert.deepEqual(await claw.remoteAgents.setup("ak-a"), { package: "@primusclaw/connector" });
    wire.answer = () => json(200, { data: "nope" });
    await assert.rejects(claw.remoteAgents.connectors("ak-a"), ClawAnswerInvalid);
  });

  it("a session starts in the mode asked, and takes over a conversation only with its reference", async () => {
    const wire = new Wire(() => json(200, { data: { session_id: "rs1" } }));
    const claw = wire.client();
    await claw.remoteAgents.createSession("ak-a", { connectorId: "c1", agentId: "a1", cwd: "/w" });
    await claw.remoteAgents.createSession("ak-a", {
      connectorId: "c1",
      agentId: "a1",
      cwd: "/w",
      mode: "plan",
      takeover: true,
    });
    await claw.remoteAgents.createSession("ak-a", {
      connectorId: "c1",
      agentId: "a1",
      cwd: "/w",
      resumeRef: "conv-1",
      takeover: true,
    });
    assert.deepEqual(
      wire.sent.map((s) => s.body),
      [
        { connector_id: "c1", agent_id: "a1", cwd: "/w" },
        { connector_id: "c1", agent_id: "a1", cwd: "/w", mode: "plan" },
        { connector_id: "c1", agent_id: "a1", cwd: "/w", resume_ref: "conv-1", takeover: true },
      ],
    );
  });
});

describe("remote agent sessions", () => {
  it("commands, decisions and revoking", async () => {
    const wire = new Wire(() => json(200, { data: { queued: true } }));
    const claw = wire.client();
    await claw.remoteAgents.command("ak-a", "rs1", { type: "prompt", text: "go" }, "idem-1");
    await claw.remoteAgents.command("ak-a", "rs1", { type: "cancel" });
    await claw.remoteAgents.decide("ak-a", "rs1", "ac1", "allow_once");
    await claw.remoteAgents.revoke("ak-a", "c1");
    assert.deepEqual(
      wire.sent.map((s) => [s.method, s.rawPath, s.headers.get("idempotency-key"), s.body]),
      [
        ["POST", "/v1/remote-agents/sessions/rs1/commands", "idem-1", { type: "prompt", text: "go" }],
        ["POST", "/v1/remote-agents/sessions/rs1/commands", null, { type: "cancel" }],
        ["POST", "/v1/remote-agents/sessions/rs1/decisions", null, { action_id: "ac1", option_id: "allow_once" }],
        ["DELETE", "/v1/remote-agents/connectors/c1", null, undefined],
      ],
    );
  });

  it("a page of stored events after a cursor", async () => {
    const wire = new Wire(() => json(200, { data: [{ id: 3, seq: 3, type: "x", ts: 5, data: {} }, "junk"] }));
    const rows = await wire.client().remoteAgents.events("ak-a", "rs1", "2", 50);
    assert.deepEqual(rows, [{ id: "3", seq: 3, type: "x", ts: 5, data: {} }]);
    assert.equal(wire.sent[0]?.url.search, "?mode=replay&limit=50&after=2");
    await wire.client().remoteAgents.events("ak-a", "rs1");
    assert.equal(wire.sent[1]?.url.search, "?mode=replay&limit=1000");
    wire.answer = () => json(200, { data: {} });
    await assert.rejects(wire.client().remoteAgents.events("ak-a", "rs1"), ClawAnswerInvalid);
  });
});

describe("hiding a machine's conversations", () => {
  it("hides or shows again by ref, and says what changed and what was refused", async () => {
    const wire = new Wire(() =>
      json(200, { ok: true, data: { changed: ["r1"], refused: [{ ref: "r2", reason: "live" }, "junk"] } }),
    );
    const claw = wire.client();
    assert.deepEqual(await claw.remoteAgents.hide("ak-a", "c1", ["r1", "r2"], true), {
      changed: ["r1"],
      refused: [{ ref: "r2", reason: "live" }],
    });
    await claw.remoteAgents.hide("ak-a", "c1", ["r1"], false);
    assert.deepEqual(
      wire.sent.map((s) => [s.method, s.rawPath, s.body]),
      [
        ["POST", "/v1/remote-agents/connectors/c1/hidden", { refs: ["r1", "r2"], hidden: true }],
        ["POST", "/v1/remote-agents/connectors/c1/hidden", { refs: ["r1"], hidden: false }],
      ],
    );
    wire.answer = () => json(404, { ok: false, error: "not_found" });
    await assert.rejects(claw.remoteAgents.hide("ak-a", "c9", ["r1"], true), { name: "ClawError", status: 404 });
  });

  it("the listing leaves hidden conversations out unless asked to include them", async () => {
    const wire = new Wire(() =>
      json(200, {
        data: [{ connector_id: "c1", agents: [{ agent_id: "a1", capabilities: { resumable: [], hidden_count: 2 } }] }],
      }),
    );
    const claw = wire.client();
    const [connector] = await claw.remoteAgents.connectors("ak-a");
    assert.equal(connector?.agents?.[0]?.capabilities?.["hidden_count"], 2);
    await claw.remoteAgents.connectors("ak-a", { includeHidden: true });
    assert.deepEqual(
      wire.sent.map((s) => s.url.search),
      ["", "?hidden=include"],
    );
  });
});
