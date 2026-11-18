// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The step labels against the Python worker's own answers (step_labels.py run over 300 inputs: labels, lookups, skill
 * directories and shells; test-support/data/step-labels/python-parity.json), byte for byte.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

import { integrationRegistry } from "../../src/plugins/integrations.js";
import { failedLine, isShell, labelFor, lookupLabel, skillInCommand } from "../../src/turn/step-labels.js";

interface Parity {
  readonly servers: Readonly<Record<string, string>>;
  readonly query: readonly string[];
  readonly labels: ReadonlyArray<{
    tool: string;
    lang: string;
    skill: string | null;
    one: string;
    many: string | null;
    text3: string;
    failed: string;
  }>;
  readonly lookups: ReadonlyArray<{ tool: string; lang: string; label: string }>;
  readonly skills: ReadonlyArray<{ command: string; skill: string | null }>;
  readonly shells: ReadonlyArray<{ tool: string; shell: boolean }>;
}

const PARITY = JSON.parse(
  readFileSync(new URL("../../../../test-support/data/step-labels/python-parity.json", import.meta.url), "utf8"),
) as Parity;
const SERVERS = integrationRegistry();
for (const [name, shown] of Object.entries(PARITY.servers)) {
  SERVERS.addMcpServer(name, shown, { query: PARITY.query.includes(name) });
}

it("every label is the Python worker's, in both languages, with its repeat count and its failure line", () => {
  assert.equal(PARITY.labels.length, 200);
  for (const c of PARITY.labels) {
    const label = labelFor(c.tool, c.skill ?? undefined, c.lang, SERVERS);
    const where = `${c.tool} ${c.lang} ${String(c.skill)}`;
    assert.equal(label.one, c.one, where);
    assert.equal(label.many ?? null, c.many, where);
    assert.equal(label.text(3), c.text3, where);
    assert.equal(failedLine(label, c.lang), c.failed, where);
  }
});

it("every lookup is the Python worker's", () => {
  assert.equal(PARITY.lookups.length, 100);
  for (const c of PARITY.lookups) assert.equal(lookupLabel(c.tool, c.lang, SERVERS), c.label, `${c.tool} ${c.lang}`);
});

it("the skill directory and the shells are read as the Python worker reads them", () => {
  for (const c of PARITY.skills) assert.equal(skillInCommand(c.command) ?? null, c.skill, c.command);
  for (const c of PARITY.shells) assert.equal(isShell(c.tool), c.shell, JSON.stringify(c.tool));
});
