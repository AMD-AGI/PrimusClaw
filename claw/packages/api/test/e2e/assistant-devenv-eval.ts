// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Measures whether the assistant drives the user's development environments from plain words (`assistant-devenv-eval-cases.ts`):
 * "让 dev-pod 上那个 codex 跑一下测试" is a devenv_send card, "切到昨天那个会话" puts that session's attach command to the user, "停掉它"
 * stops the item it started, "新开一个会话在 ~/repo 里看看" is a card for a new session in that folder. The Router's real prompt and
 * tool definitions (remote agents and the assistant's tools on) against a real model; the tools are answered by a stand-in.
 *
 *   EVAL_BASE_URL=https://gateway.example/api EVAL_MODEL=<the Router's model> EVAL_KEY_FILE=/path/to/key \
 *     npx tsx test/e2e/assistant-devenv-eval.ts
 *
 * Optional: EVAL_RUNS (default 1), EVAL_CONCURRENCY (default 2, at most 4), EVAL_CASES (comma list of ids), EVAL_OUT (a directory for
 * the traces). The key is read when it is used and never printed. The last line is a JSON summary; exit 0 only when every case of the
 * whole set passed in every run.
 */
process.env.CLAW_REMOTE_AGENTS_ENABLED ??= "true";
process.env.CLAW_ASSISTANT_TOOLS ??= "on";
process.env.CLAW_ASSISTANT_ENABLED ??= "true";
process.env.CLAW_TRIGGERS_ENABLED ??= "true";
process.env.CLAW_TRIGGER_TOOLS_ENABLED ??= "true";

const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { routerTools, pool } = await import("./assistant-router-eval-lib.js");
const { CASES } = await import("./assistant-devenv-eval-cases.js");
const { callLine, messagesLlm, runDevenvCase, scoreDevenv } = await import("./assistant-devenv-eval-lib.js");

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};
const BASE_URL = need("EVAL_BASE_URL");
const MODEL = need("EVAL_MODEL");
const key = (): string => (process.env.EVAL_KEY ?? readFileSync(need("EVAL_KEY_FILE"), "utf8")).trim();
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 1) | 0);
const CONC = Math.min(4, Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 2) | 0));
const ONLY = new Set((process.env.EVAL_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const OUT = process.env.EVAL_OUT;

const llm = messagesLlm({ baseUrl: BASE_URL, model: MODEL, apiKey: key });
const tools = await routerTools();
const cases = ONLY.size ? CASES.filter((c) => ONLY.has(c.id)) : CASES;
const names = tools.map((t) => t.name.split("__").pop());
for (const need of ["devenv_list", "devenv_send", "channel_action", "work_stop"]) {
  if (!names.includes(need)) { console.error(`the router is not offered ${need}: the evaluation would measure nothing`); process.exit(2); }
}
console.log(new Date().toISOString(), `model=${MODEL} cases=${cases.length} runs=${RUNS}`);
const passed: number[] = [];
for (let run = 1; run <= RUNS; run++) {
  const traces = await pool(cases, CONC, (c) => runDevenvCase(c, { llm, tools }));
  const scores = cases.map((c, i) => scoreDevenv(c, traces[i]));
  passed.push(scores.filter((s) => s.pass).length);
  console.log(`run ${run}/${RUNS}: ${passed[run - 1]}/${cases.length}`);
  scores.forEach((s, i) => console.log(`  ${s.pass ? "PASS" : "MISS"} ${s.id} ${JSON.stringify(cases[i].text)}\n       ${callLine(traces[i])}${s.why.length ? `\n       why: ${s.why.join("; ")}` : ""}\n       said: ${traces[i].said.replace(/\s+/g, " ").slice(0, 160)}`));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `devenv-run-${run}.json`), JSON.stringify({ model: MODEL, cases: cases.map((c, i) => ({ id: c.id, text: c.text, score: scores[i], trace: traces[i] })) }, null, 2));
  }
}
const full = cases.length === CASES.length;
const ok = full && passed.every((p) => p === cases.length);
console.log(JSON.stringify({ model: MODEL, cases: cases.length, full_set: full, runs: RUNS, passed, ok }));
process.exit(ok ? 0 : 1);
