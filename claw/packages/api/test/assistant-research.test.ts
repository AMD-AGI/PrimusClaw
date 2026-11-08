// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Research reports (`CLAW_ASSISTANT_RESEARCH`, `assistant/research.ts`): what a worker turn is given, and what the prompts say.
 *
 *   RS1 on: a worker turn's deliver_text is named for Brain's citation check, and its system text gets the research method
 *   RS2 off: neither, and a cite_check the request carried is taken off
 *   RS3 the worker is told the exact list-of-sources form Brain's check reads, to cite only pages it fetched, and that unverified
 *       findings are marked before the file is stored
 *   RS4 the router is told a research report is a work item, never text it writes from what it knows
 *   RS5 the switch is off by default
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkerResearch, assistantResearchOn, RESEARCH_CHECKED_TOOL, ROUTER_RESEARCH_PROMPT, WORKER_RESEARCH_PROMPT,
} from "../src/assistant/research.js";

test("RS1 on: the worker's deliver_text is checked and the method is in its system text", () => {
  const task: Record<string, unknown> = {};
  const appended: string[] = [];
  assert.equal(applyWorkerResearch(task, (t) => appended.push(t), true), true);
  assert.deepEqual(task.cite_check, { tools: ["mcp__assistant__deliver_text"] });
  assert.equal(RESEARCH_CHECKED_TOOL, "mcp__assistant__deliver_text");
  assert.deepEqual(appended, [WORKER_RESEARCH_PROMPT]);
});

test("RS2 off: nothing is added, and a carried cite_check is removed", () => {
  const task: Record<string, unknown> = { cite_check: { tools: ["mcp__assistant__deliver_text"] } };
  const appended: string[] = [];
  assert.equal(applyWorkerResearch(task, (t) => appended.push(t), false), false);
  assert.equal("cite_check" in task, false);
  assert.deepEqual(appended, []);
});

test("RS3 the worker is told the form the check reads and what the check does", () => {
  assert.match(WORKER_RESEARCH_PROMPT, /\[n\]: title — https:\/\/the\.address\/of\/the\/page/);
  assert.match(WORKER_RESEARCH_PROMPT, /Only pages you opened with web_fetch/);
  assert.match(WORKER_RESEARCH_PROMPT, /ends with its citation: \[1\], or \[1\]\[3\]/);
  assert.match(WORKER_RESEARCH_PROMPT, /marked unverified \(未证实\)/);
  assert.match(WORKER_RESEARCH_PROMPT, /deliver_text/);
  assert.match(WORKER_RESEARCH_PROMPT, /report\(kind="answer"\)/);
});

test("RS4 the router hands research to a work item", () => {
  assert.match(ROUTER_RESEARCH_PROMPT, /is a work item, not Writing is yours/);
  assert.match(ROUTER_RESEARCH_PROMPT, /Never write such a report yourself/);
  assert.match(ROUTER_RESEARCH_PROMPT, /work_create/);
});

test("RS5 off unless switched on", () => {
  assert.equal(process.env.CLAW_ASSISTANT_RESEARCH, undefined);
  assert.equal(assistantResearchOn(), false);
});
