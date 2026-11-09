// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Which machine and agent a typed name means, and how an offline machine is told (`remote/machines.ts`).
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Resolved, offlineText, resolveAgent } from "../../src/remote/machines.js";
import { type Connector, connectorFrom } from "../../src/remote/model.js";

const NOW = 1_762_700_000;
const CJK = /[一-鿿]/u;

interface AgentFields {
  readonly kind?: string;
  readonly name?: string;
}

/** An agent as a connector reports it. */
const agent = (agentId: string, fields: AgentFields = {}): Record<string, unknown> => ({
  agent_id: agentId,
  ...fields,
});

/** A machine as Claw lists it. */
const machine = (
  connectorId: string,
  name: string,
  online: boolean,
  agents: Record<string, unknown>[],
  lastSeenAt?: string,
): Connector =>
  connectorFrom({
    connector_id: connectorId,
    name,
    online,
    agents,
    ...(lastSeenAt === undefined ? {} : { last_seen_at: lastSeenAt }),
  });

const seen = (secondsAgo: number): string => new Date((NOW - secondsAgo) * 1000).toISOString();

const textOf = (resolved: Resolved): string => (resolved.kind === "refusal" ? resolved.text : "");

test("an offline machine is told as reconnecting only when it was heard from moments ago", () => {
  for (const [ago, expected] of [
    [30, "dev-pod lost its connection a moment ago and is most likely reconnecting by itself"],
    [600, "dev-pod is offline. Start its connector again, then try again."],
  ] as const) {
    const off = machine("c1", "dev-pod", false, [agent("codex", { kind: "codex", name: "Codex" })], seen(ago));
    assert.ok(offlineText(off, NOW).startsWith(expected));
    // One coming back is tried (and asked again once it is back); one gone for good is refused with the sentence.
    const chosen = resolveAgent([off], "codex", NOW);
    if (ago < 120) assert.deepEqual(chosen, { kind: "agent", connector: off, agent: off.agents[0] });
    else assert.ok(textOf(chosen).startsWith(expected));
  }
});

const A = machine("1", "dev-pod", true, [agent("codex")]);
const B = machine("2", "laptop", false, [agent("codex")]);
const C = machine("3", "lab", true, [agent("codex")]);

test("resolve agent prefers the one online machine and asks when it cannot choose", () => {
  const first = resolveAgent([A, B], "codex", NOW);
  assert.ok(first.kind === "agent" && first.connector === A);
  assert.equal(
    textOf(resolveAgent([B], "codex", NOW)),
    "laptop is offline. Start its connector again, then try again.",
  );
  assert.ok(textOf(resolveAgent([A, C], "codex", NOW)).startsWith("More than one machine has that agent."));
  const named = resolveAgent([A, C], "lab/CODEX", NOW);
  assert.ok(named.kind === "agent" && named.connector === C);
  assert.ok(textOf(resolveAgent([A], "nope", NOW)).startsWith("I could not find an agent called `nope`"));
  assert.ok(textOf(resolveAgent([A], "lab/codex", NOW)).startsWith("I could not find an agent called `lab/codex`"));
});

test("resolve agent says why not in the chat language", () => {
  for (const [connectors, ref] of [
    [[B], "codex"],
    [[A, C], "codex"],
    [[A], "nope"],
    [[B], "laptop"],
  ] as const) {
    const english = textOf(resolveAgent(connectors, ref, NOW));
    const chinese = textOf(resolveAgent(connectors, ref, NOW, "zh"));
    assert.ok(english && !CJK.test(english) && CJK.test(chinese), `${english} / ${chinese}`);
  }
});

test("a name that is a machine's means its only agent or a choice among its agents", () => {
  const two = machine("4", "box", true, [
    agent("codex"),
    agent("claude", { kind: "claude-code", name: "Claude Code" }),
  ]);
  const choice = resolveAgent([two], "box", NOW);
  assert.ok(choice.kind === "machine" && choice.agents.length === 2);
  const byKind = resolveAgent([two], "claude", NOW);
  assert.ok(byKind.kind === "agent" && byKind.agent.agentId === "claude");
  const byName = resolveAgent([two], "box/Claude Code", NOW);
  assert.ok(byName.kind === "agent" && byName.agent.agentId === "claude");
  assert.equal(
    textOf(resolveAgent([two], "cla", NOW)),
    "I could not find an agent called `cla`. Send /agents to see yours.",
  );
  const empty = machine("5", "bare", true, [agent("")]);
  assert.equal(
    textOf(resolveAgent([empty], "bare", NOW)),
    "bare has not reported an agent yet. Send /agents to see what is there.",
  );
  const twins = [machine("6", "twin", true, [agent("a")]), machine("7", "twin", true, [agent("b")])];
  assert.equal(
    textOf(resolveAgent(twins, "twin", NOW)),
    "More than one machine is called `twin`. Send /agents and use the buttons.",
  );
  const gone = machine("8", "gone", false, [agent("a")]);
  assert.equal(
    textOf(resolveAgent([gone], "gone", NOW)),
    "gone is offline. Start its connector again, then try again.",
  );
});
