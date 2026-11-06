// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The last layer of `resolveItemModel` (`model-choice.ts`): model choice on, no default of the user's and none of the deployment's for the
 * kind. The item's session then names no model and Brain's DEFAULT_MODEL runs, unasked. Real Postgres; skipped without DATABASE_URL.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant model choice, no defaults", { skip }, () => {
  let w: World;
  let listed = 0;
  before(async () => {
    w = await startWorld({
      CLAW_ASSISTANT_MODEL_CHOICE: "on",
      CLAW_ASSISTANT_MODELS: "claude-opus-5.5=strongest,claude-sonnet-5.5=default",
    });
    const mc = await import("../src/assistant/model-choice.js");
    mc.modelChoicePorts.listModels = async () => { listed += 1; return ["claude-opus-5.5", "claude-sonnet-5.5"]; };
  });
  after(async () => { await w?.stop(); });

  test("D1 nothing names a model: the session names none, the item records null, and the gateway is not asked", async () => {
    const alice = await w.user("alice");
    const turn = await w.routerTurn(alice);
    const created = await w.mod.tools.workCreate(turn, { title: "t", brief: "b" });
    assert.equal(created.model, null);
    const item = await w.item(created.item_id);
    assert.deepEqual(item.params, { model: null });
    assert.equal((await w.q("SELECT model FROM claw_sessions WHERE session_id = $1", [item.worker_session_id]))[0].model, null);
    assert.equal(listed, 0);
    const mc = await import("../src/assistant/model-choice.js");
    const r = await mc.resolveItemModel((t, a) => w.h.app.db.db.query(t, a), { kind: "review", payerUserId: "alice", payerKey: "vk-alice" });
    assert.deepEqual(r, { model: null, source: "deployment_default" });
  });
});
