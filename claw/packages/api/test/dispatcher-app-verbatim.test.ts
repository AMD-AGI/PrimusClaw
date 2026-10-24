// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run is dispatched as it was admitted.
 *
 * Its sandbox spec is the platform's resolved answer, and its input is the app's
 * own: the platform never interprets app input. A `${task.input...}` template in
 * the spec (a submitter's `resources.image`, which admission accepts as a string)
 * must therefore reach the row unexpanded, or the input would change the image
 * after admission. The same row in an ordinary mode is expanded -- the control
 * that makes the first assertion mean something.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";
process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.LLM_KEY_SOURCE = "virtualKey";
const { db } = await import("../src/infra/db.js");
const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");

const originalQuery = db.query;
const originalPublish = taskPublisher.publish;
after(() => {
  db.query = originalQuery;
  taskPublisher.publish = originalPublish;
});

const TEMPLATE = "${task.input.framework.image}";
const ATTACKER = "attacker.example.invalid/other:1";

/** Dispatch a row of this mode and return every sandbox_spec the dispatcher wrote back. */
async function persistedSpecs(mode: string): Promise<string[]> {
  const row = {
    task_id: "ktsk_app", session_id: "s-1", dag_id: null, dag_node_id: null, dag_root_task_id: null,
    status: "preparing", started_at: new Date().toISOString(), prompt: null, script: null,
    sandbox_spec: { handle: "app", image: TEMPLATE, resources: { cpu: "4" } },
    input: { framework: { image: ATTACKER } }, metadata: {}, depends_on: [], mode,
  };
  const written: string[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/^UPDATE claw_tasks SET/.test(sql)) {
      for (const p of params) if (typeof p === "string" && p.includes('"handle"')) written.push(p);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) {
      return { rows: [{ user_id: "u-1", config: { platform_key: "pk", _server_managed_credentials: true } }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  await dispatchTask("ktsk_app");
  return written;
}

test("an app run's sandbox spec reaches the row with its template untouched", async () => {
  const specs = await persistedSpecs("app");
  assert.ok(specs.length > 0, "the dispatch persisted the spec, or this proves nothing");
  for (const s of specs) {
    assert.equal(JSON.parse(s).image, TEMPLATE);
    assert.ok(!s.includes(ATTACKER), "the app's input never becomes part of the spec");
  }
});

test("control: the same spec on an ordinary task is expanded", async () => {
  const specs = await persistedSpecs("llm");
  assert.ok(specs.length > 0);
  assert.equal(JSON.parse(specs[0]!).image, ATTACKER);
});
