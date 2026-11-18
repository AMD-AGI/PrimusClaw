// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `wait` under a tool allow-list, with background shells on.
 *
 * The bash schema tells the model to start a long command with run_in_background=true "then call wait". A requested review's profile
 * allowed bash and bash_output but not wait, so a review that followed the schema was refused and spent a turn on nothing (22 review
 * sessions in a day). `wait` only waits for a shell this run started (its shell_id is qualified by the run, as bash_output's is), so the
 * profile allows it; and every list Brain itself defines is checked here for the same shape:
 *
 *   W1  under the review profile `wait` is offered, and routed rather than refused
 *   W2  the closed set (the review profile, each sub-agent profile alone and under the review profile): a list that offers bash and
 *       bash_output offers wait, and the bash schema the model finally sees names no background tool it is not offered
 *   W3  `fitShellSchemas` on every subset of the background tools: bash names wait only with wait, bash_output only with it, and keeps
 *       run_in_background only when something can read the shell
 */
process.env.BG_SHELL_ENABLED = "true";

import test from "node:test";
import assert from "node:assert/strict";
import type { ToolSchema } from "@claw/protocol";

const { ToolRouter, fitShellSchemas } = await import("../src/tools/router.js");
const { filterToolSchemas, parseToolAllowlist } = await import("../src/tools/allowlist.js");
const { REVIEW_PROFILE_TOOLS, reviewProfileAllowlist } = await import("../src/agent/review-profile.js");
const { SUBAGENT_TYPES, filterSchemas } = await import("../src/agent/sub-agent.js");
type HandsClient = import("../src/clients/hands.js").HandsClient;
type ToolAllowlist = import("../src/tools/allowlist.js").ToolAllowlist;

const BACKGROUND = ["bash_output", "kill_shell", "wait"] as const;

/** The background tools a bash schema tells the model to call. */
function namedBy(bash: ToolSchema): Set<string> {
  const text = JSON.stringify(bash);
  const named = new Set<string>();
  if (/\b(?:call|plus|with) wait\b/.test(text)) named.add("wait");
  if (/\bbash_output\b/.test(text)) named.add("bash_output");
  if (/\bkill_shell\b/.test(text)) named.add("kill_shell");
  return named;
}

function assertBashFits(schemas: ToolSchema[], label: string): void {
  const offered = new Set(schemas.map((s) => s.name));
  const bash = schemas.find((s) => s.name === "bash");
  if (!bash) return;
  for (const name of namedBy(bash)) assert.ok(offered.has(name), `${label}: bash names ${name}, which is not offered`);
  const props = (bash.input_schema as { properties: Record<string, unknown> }).properties;
  if ("run_in_background" in props) {
    assert.ok(offered.has("wait") || offered.has("bash_output"), `${label}: bash offers run_in_background with nothing to read the shell`);
  }
}

function engineSchemas(list: ToolAllowlist | null): ToolSchema[] {
  // What engine.ts offers the model: the router's schemas, the run's allow-list, then the fit.
  return fitShellSchemas(filterToolSchemas(new ToolRouter(null).getToolSchemas(), list));
}

const REVIEW = () => reviewProfileAllowlist(parseToolAllowlist([...REVIEW_PROFILE_TOOLS]));

test("W1 under the review profile wait is offered, and a wait is routed to the sandbox rather than refused", async () => {
  const names = filterToolSchemas(new ToolRouter(null).getToolSchemas(), REVIEW()).map((s) => s.name);
  for (const name of ["bash", "bash_output", "wait", "kill_shell"]) assert.ok(names.includes(name), name);

  const calls: string[] = [];
  const hands = {
    callTool: async (name: string) => { calls.push(name); return "ran"; },
    callToolFull: async (name: string) => { calls.push(name); return { text: "done", isError: false }; },
  } as unknown as HandsClient;
  const router = new ToolRouter(hands);
  router.setToolAllowlist(REVIEW());
  const out = await router.route("wait", { shell_id: "build" });
  assert.doesNotMatch(String(out), /not available in this session/);
  assert.deepEqual(calls, ["wait"]);

  // Control: the same call under a list without wait is refused before the sandbox.
  const narrow = new ToolRouter(hands);
  narrow.setToolAllowlist(parseToolAllowlist(["bash", "bash_output"]));
  assert.match(String(await narrow.route("wait", { shell_id: "build" })), /not available in this session/);
  assert.deepEqual(calls, ["wait"]);
});

test("W2 every list Brain defines: bash with bash_output means wait too, and bash names only what the model is offered", () => {
  const rows: Array<{ label: string; schemas: ToolSchema[] }> = [{ label: "review profile", schemas: engineSchemas(REVIEW()) }];
  for (const type of SUBAGENT_TYPES) {
    rows.push({ label: `sub-agent ${type}`, schemas: filterSchemas(engineSchemas(null), type) });
    rows.push({ label: `sub-agent ${type} under the review profile`, schemas: filterSchemas(engineSchemas(REVIEW()), type, undefined, REVIEW()) });
  }
  for (const { label, schemas } of rows) {
    const offered = new Set(schemas.map((s) => s.name));
    if (offered.has("bash") && offered.has("bash_output")) {
      assert.ok(offered.has("wait"), `${label}: offers bash and bash_output but not wait, the tool its bash schema is written around`);
    }
    assertBashFits(schemas, label);
  }
});

test("W3 the bash schema is fitted to whichever background tools are offered", () => {
  const all = new ToolRouter(null).getToolSchemas();
  for (let mask = 0; mask < 1 << BACKGROUND.length; mask++) {
    const kept = BACKGROUND.filter((_, i) => mask & (1 << i));
    const schemas = fitShellSchemas(filterToolSchemas(all, parseToolAllowlist(["bash", ...kept])));
    const label = `bash + [${kept.join(", ")}]`;
    assertBashFits(schemas, label);
    const bash = schemas.find((s) => s.name === "bash")!;
    const props = Object.keys((bash.input_schema as { properties: Record<string, unknown> }).properties);
    const readable = kept.includes("wait") || kept.includes("bash_output");
    assert.equal(props.includes("run_in_background"), readable, label);
    if (kept.includes("wait")) assert.ok(namedBy(bash).has("wait"), `${label}: wait is offered and named`);
    else if (kept.includes("bash_output")) assert.ok(namedBy(bash).has("bash_output"), `${label}: bash_output is how this run reads a shell`);
  }
  // Unrestricted: the schema is the router's own, untouched.
  assert.deepEqual(fitShellSchemas(all), all);
});
