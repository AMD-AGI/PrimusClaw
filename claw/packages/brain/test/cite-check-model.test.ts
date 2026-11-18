// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * CITE_CHECK_MODEL names the model that judges a research report's citations (`tools/web/cite-check-ports.ts`). Its own file: the
 * setting is read when the config loads.
 *
 *   CM1 set: every judge call is made on that model, not the page summarizer's
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CITE_CHECK_MODEL = "claude-sonnet-5.5";
process.env.WEB_FETCH_SUMMARIZE_MODEL = "claude-haiku-5.5";
const { webCiteCheckPorts } = await import("../src/tools/web/cite-check-ports.js");

test("CM1 CITE_CHECK_MODEL set: the judge runs on it", async () => {
  const models: string[] = [];
  const ctx = {
    anthropic: { messages: { create: async (body: { model: string }) => {
      models.push(body.model);
      return { content: [{ type: "text", text: "[true]" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    } } },
    sessionCost: { addUsage() {} },
  };
  const ports = webCiteCheckPorts({} as never, ctx as never)!;
  assert.deepEqual(await ports.judge({ url: "https://x.example/a", page: "p", claims: ["c"] }, new AbortController().signal), [true]);
  assert.deepEqual(models, ["claude-sonnet-5.5"]);
});
