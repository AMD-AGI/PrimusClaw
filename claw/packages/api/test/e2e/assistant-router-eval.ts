// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Measures how well the assistant's Router dispatches: given the work items the user has and a message, does it
 * create, forward, stop or just answer, as a person would expect. It runs the Router's real system prompt and tool
 * definitions (imported, not copied) against a real model through an Anthropic-compatible gateway, with the tools
 * answered by a stand-in, and scores the decisions against `assistant-router-eval-cases.ts`.
 *
 * The plan's gate (super-agent P1 plan, 12.7): at least 60 cases, at least 95% of the dispatch decisions right,
 * before the assistant is turned on for everyone. Exit 0 only if every run reaches the gate.
 *
 *   EVAL_BASE_URL=https://gateway.example/api EVAL_MODEL=<the Router's model> EVAL_KEY_FILE=/path/to/key \
 *     npx tsx test/e2e/assistant-router-eval.ts
 *
 * Required: EVAL_BASE_URL (the gateway root, to which `/v1/messages` is appended), EVAL_MODEL, and the key as
 * EVAL_KEY or EVAL_KEY_FILE. The key is read when it is used and never printed or written to the results.
 * Optional:
 *   EVAL_RUNS          runs of the whole set (default 1; the model is not deterministic, so use 3)
 *   EVAL_CONCURRENCY   calls in flight (default 2, at most 4)
 *   EVAL_CASES         comma list of case ids or kinds to run (default all)
 *   EVAL_OUT           a directory for the full traces, one JSON file per run (default: none)
 *   EVAL_GATE          the accuracy to reach, 0..1 (default 0.95)
 *   EVAL_STRICT_IDS    default 1: an item reference that is not the item's real id is refused, as the real tools
 *                      refuse it, so the score is what the system as built would do. 0: "#3" and "3" are read as item 3,
 *                      which scores the Router's decisions apart from how it names an item (the count of references that
 *                      are not a real id is printed either way).
 *
 * The last line is a JSON summary.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CASES, type EvalCase } from "./assistant-router-eval-cases.js";
import {
  describeEffects, messagesLlm, pool, routerTools, runCase, scoreCase, summarize, type Score, type Trace,
} from "./assistant-router-eval-lib.js";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};

const BASE_URL = need("EVAL_BASE_URL").replace(/\/+$/, "");
const MODEL = need("EVAL_MODEL");
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 1));
const CONCURRENCY = Math.min(4, Math.max(1, Number(process.env.EVAL_CONCURRENCY || 2)));
const GATE = Number(process.env.EVAL_GATE || 0.95);
const OUT = process.env.EVAL_OUT;
const STRICT_IDS = process.env.EVAL_STRICT_IDS !== "0";
const ONLY = new Set((process.env.EVAL_CASES || "").split(",").map((s) => s.trim()).filter(Boolean));

/** The key: from the environment or the file it names. Never printed, never written to the results. */
function apiKey(): string {
  const direct = process.env.EVAL_KEY;
  if (direct) return direct.trim();
  const file = process.env.EVAL_KEY_FILE;
  if (!file) { console.error("EVAL_KEY or EVAL_KEY_FILE is required"); process.exit(2); }
  return readFileSync(file, "utf8").trim();
}
let KEY = apiKey(); // read now to fail early, and again at the start of each run

const llm = messagesLlm({ baseUrl: BASE_URL, model: MODEL, apiKey: () => KEY });

const iso = (): string => new Date().toISOString();

const pct = (n: number, d: number): string => `${((100 * n) / d).toFixed(1)}%`;

async function main(): Promise<void> {
  const cases: readonly EvalCase[] = ONLY.size ? CASES.filter((c) => ONLY.has(c.id) || ONLY.has(c.kind)) : CASES;
  if (!cases.length) { console.error("no case selected"); process.exit(2); }
  const tools = await routerTools();
  console.log(iso(), `model=${MODEL} cases=${cases.length} runs=${RUNS} concurrency=${CONCURRENCY} strict_ids=${STRICT_IDS} tools=${tools.map((t) => t.name).join(",")}`);

  const accuracies: number[] = [];
  for (let run = 1; run <= RUNS; run++) {
    KEY = apiKey();
    const started = Date.now();
    const done = await pool(cases, CONCURRENCY, async (c): Promise<{ c: EvalCase; trace: Trace; score: Score }> => {
      const trace = await runCase(c, { llm, tools, strictIds: STRICT_IDS });
      return { c, trace, score: scoreCase(c, trace) };
    });
    const scores = done.map((d) => d.score);
    const sum = summarize(scores);
    accuracies.push(sum.dispatchOk / sum.total);
    console.log(`\n${iso()} run ${run}/${RUNS}: dispatch ${sum.dispatchOk}/${sum.total} (${pct(sum.dispatchOk, sum.total)}), whole turn ${sum.turnOk}/${sum.total} (${pct(sum.turnOk, sum.total)}), errors ${sum.errors}, ${Math.round((Date.now() - started) / 1000)}s`);
    console.log("  by kind: " + Object.entries(sum.byKind).map(([k, v]) => `${k} ${v.dispatchOk}/${v.total}`).join(", "));
    const inexact = scores.reduce((n, s) => n + s.inexactRefs, 0);
    const refused = scores.reduce((n, s) => n + s.refusals.length, 0);
    console.log(`  item references that are not the item's real id: ${inexact}; calls the tools refused: ${refused}`);
    console.log(`  replies written in the same step as a work call, before its result: ${scores.reduce((n, s) => n + s.saidBeforeResult, 0)}; of those beside a call that was refused: ${scores.reduce((n, s) => n + s.saidBesideRefusal, 0)}`);
    for (const { c, trace, score } of done) {
      if (score.turnOk) continue;
      const why = [
        !score.dispatchOk ? "DISPATCH" : "", !score.spokeOk ? "NO-SAY" : "", !score.sayItemOk ? "SAY-ITEM" : "", !score.langOk ? "LANG" : "",
        score.error ? `ERROR(${score.error})` : "",
      ].filter(Boolean).join(" ");
      console.log(`  MISS ${c.id} [${why}] "${c.text.slice(0, 90).replace(/\n/g, " ")}"`);
      console.log(`       wanted: ${[c.expect, ...(c.also ?? [])].map(describeEffects).join("  |  ")}`);
      console.log(`       got:    ${describeEffects(score.actual)}${score.refusals.length ? `  (refused: ${score.refusals.join(", ")})` : ""}`);
      const say = trace.calls.find((x) => x.tool === "say");
      if (say) console.log(`       said:   ${String(say.input.text ?? "").slice(0, 160).replace(/\n/g, " ")}`);
    }
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `run-${run}.json`), JSON.stringify({
        model: MODEL, finished_at: iso(), summary: sum,
        cases: done.map((d) => ({ id: d.c.id, kind: d.c.kind, text: d.c.text, score: d.score, trace: d.trace })),
      }, null, 1));
    }
  }

  const ok = accuracies.every((a) => a >= GATE);
  console.log(JSON.stringify({ model: MODEL, cases: cases.length, runs: RUNS, gate: GATE, accuracy: accuracies, passed: ok }));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
