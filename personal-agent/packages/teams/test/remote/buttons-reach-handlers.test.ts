// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every button of a remote-agent card reaches the remote-agent click handler: its Action.Execute, pressed in Teams, read by the
 * channel's inbound reader, names a verb the handler registered (a card whose data names no registered verb is a button that does
 * nothing when pressed).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { REMOTE, connector, agent, windowState } from "../../../../test-support/card-catalog/remote.js";
import { remoteWorld } from "../../../../test-support/remote-world.js";
import { toInboundEvent } from "../../src/activity/inbound/index.js";
import { hiddenCard, machineChoiceCard, modeCard, takeoverCard, windowCard } from "../../src/views/remote/index.js";
import { dm } from "../activity/fixtures.js";

type Json = Record<string, unknown>;

function* executes(node: unknown): Generator<Json> {
  if (Array.isArray(node)) for (const v of node) yield* executes(v);
  else if (node && typeof node === "object") {
    const n = node as Json;
    if (n["type"] === "Action.Execute") yield n;
    for (const v of Object.values(n)) if (v && typeof v === "object") yield* executes(v);
  }
}

function moreCards(): Json[] {
  const hiding = connector({
    connectorId: "c1",
    name: "box",
    online: true,
    agents: [
      agent({
        agentId: "a1",
        kind: "attach",
        capabilities: {
          hidden_count: 1,
          resumable: [
            { ref: "r1", cwd: "/w", state: "idle" },
            { ref: "r2", cwd: "/w", state: "idle" },
            { ref: "r3", cwd: "/w", state: "unknown" },
            { ref: "r4", cwd: "/w", state: "idle", hidden: true },
          ],
        },
      }),
    ],
  });
  const a = hiding.agents[0] ?? agent({ agentId: "x" });
  const entry = remoteDomain.resumableOf(a)[0];
  if (!entry) throw new Error("the fixture lost a conversation");
  const options = remoteDomain.parseOptions([{ optionId: "o1", kind: "allow_once", name: "Allow" }]);
  return [
    hiddenCard(remoteView.hiddenView(hiding, 0)),
    machineChoiceCard(remoteView.machineChoiceView(hiding, hiding.agents, "tok", "/w")),
    modeCard(remoteView.modeView("s1", "a", ["a", "b"])),
    takeoverCard(remoteView.takeoverView(hiding, a, entry, "en", "sessions")),
    ...(["idle", "watching"] as const).map((phase) =>
      windowCard(
        remoteView.windowView({
          label: "x",
          host: "h",
          cwd: "/",
          mode: "m",
          sessionId: "s1",
          phase,
          at: 0,
          lang: "en",
          hasModes: true,
          bot: "PrimusClaw Assistant",
          view: windowState({ text: "y\n".repeat(80) }),
          approvals: [
            { actionId: "a", tool: "t", expiresAt: 0, buttons: remoteView.optionButtons(options, "s1", "a") },
          ],
          takeover: { connector_id: "c1", agent_id: "a1", resume: "r1" },
        }),
      ),
    ),
  ] as Json[];
}

test("every button of a remote-agent card reaches the remote-agent click handler", async () => {
  const verbs = await remoteWorld(async (w) => Promise.resolve(new Set(w.remote.clickHandler.verbs)));
  const cards = [...REMOTE.map((e) => e.build() as Json), ...moreCards()];
  let pressed = 0;
  for (const card of cards) {
    for (const button of executes(card)) {
      const press = toInboundEvent({
        ...dm(""),
        type: "invoke",
        name: "adaptiveCard/action",
        replyToId: "card-1",
        value: { action: { type: "Action.Execute", verb: button["verb"], data: button["data"] } },
      });
      assert.ok(press.ok && press.value?.type === "action", JSON.stringify(button));
      assert.ok(verbs.has(press.value.verb), `${String(button["title"])}: ${press.value.verb}`);
      pressed += 1;
    }
  }
  assert.ok(pressed > 40, String(pressed));
});
