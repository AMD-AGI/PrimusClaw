// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether the Router, with the review and settings tools on, does what a person means on the cases in
 * `assistant-review-eval-cases.ts`: the real messages of B#1-15 and an adversarial set, against a real model through an
 * Anthropic-compatible gateway. A case is right only when the writes that went through are exactly the expected tool
 * calls with the expected arguments. The gate is every case right in every run (the design's bar for write cases).
 *
 *   EVAL_BASE_URL=https://gateway.example/api EVAL_MODEL=<the Router's model> EVAL_KEY_FILE=/path/to/key \
 *     npx tsx test/e2e/assistant-review-eval.ts
 *
 * EVAL_RUNS (default 1), EVAL_CASES (comma list of ids; a subset never passes), EVAL_OUT (a directory for traces).
 * The key is read when used and never printed or written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { messagesLlm, numberFromEnv, pool } from "./assistant-router-eval-lib.js";
import { REVIEW_CASES } from "./assistant-review-eval-cases.js";
import { reviewRouterTools, runReviewCase, scoreReviewCase } from "./assistant-review-eval-lib.js";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};
const BASE_URL = need("EVAL_BASE_URL");
const MODEL = need("EVAL_MODEL");
const RUNS = Math.floor(numberFromEnv(process.env.EVAL_RUNS, "EVAL_RUNS", 1, 1));
const ONLY = new Set((process.env.EVAL_CASES || "").split(",").map((s) => s.trim()).filter(Boolean));
const OUT = process.env.EVAL_OUT;
const apiKey = (): string => (process.env.EVAL_KEY ?? readFileSync(need("EVAL_KEY_FILE"), "utf8")).trim();

const cases = REVIEW_CASES.filter((c) => !ONLY.size || ONLY.has(c.id));
const llm = messagesLlm({ baseUrl: BASE_URL, model: MODEL, apiKey });
const tools = await reviewRouterTools();
const perRun: number[] = [];
for (let run = 1; run <= RUNS; run++) {
  const traces = await pool(cases, 2, (c) => runReviewCase(c, llm, tools));
  let right = 0;
  cases.forEach((c, i) => {
    const t = traces[i]!;
    const s = scoreReviewCase(c, t);
    if (s.ok) right++;
    const writes = s.writes.map((w) => `${w.tool}(${JSON.stringify(w.input)})`).join(" + ") || "no write";
    const refused = t.calls.filter((x) => x.refused).map((x) => `${x.tool}:${(x.result as { error?: string }).error}`).join(",");
    console.log(`run ${run} ${s.ok ? "OK  " : "FAIL"} ${c.id.padEnd(16)} ${writes}${refused ? ` | refused ${refused}` : ""}${t.error ? ` | error ${t.error}` : ""}`);
  });
  perRun.push(right / cases.length);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `review-eval-run${run}.json`), JSON.stringify(cases.map((c, i) => ({ id: c.id, trace: traces[i] })), null, 2));
  }
}
const full = cases.length === REVIEW_CASES.length;
const passed = full && perRun.length === RUNS && perRun.every((a) => a === 1);
console.log(JSON.stringify({ model: MODEL, cases: cases.length, full_set: full, runs: RUNS, accuracy: perRun, passed }));
process.exit(passed ? 0 : 1);
