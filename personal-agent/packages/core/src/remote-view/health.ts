// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A machine's health: what its connector's own checks found (`claw-connector doctor`, reported in every agent's
 * `capabilities.health` as {checked_at, problems: [{code, severity, scope, detail, fix}]}). The words are ours, per code; the
 * connector's `fix` is shown as the command, made inert; an unknown code shows its `detail`.
 */
import { lit, neutral, plain } from "./inert.js";
import type { Lang } from "../locales/lang.js";
import { remoteHealthText, remoteText } from "../locales/remote.js";
import { kindLabel } from "./agents.js";
import { HEALTH_LINES_MAX, HEALTH_READ_MAX } from "./limits.js";
import { orEmpty, pyStr, slice } from "./py-text.js";
import { type Reported, agentsOf, list, objOrNull, obj } from "./reported.js";

export interface MachineProblem {
  /** The agent it is about, or null for one of the machine as a whole (said once). */
  readonly agent: Reported | null;
  readonly code: string;
  /** A failure, not a warning. */
  readonly fail: boolean;
  readonly detail: unknown;
  readonly fix: unknown;
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A fix that is a command line (said as "run `…`"), not a sentence of what to do (said as "Fix: …"). */
const COMMAND_FIX = /^\(?(?:claude|codex|claw-connector|npm|npx|mkdir|chmod|export|loginctl|agent|curl|crontab|sh)\b/;

function problemsOf(agent: Reported): { problems: readonly unknown[]; checked: string | null } | null {
  const health = objOrNull(obj(agent["capabilities"])["health"]);
  if (!health || !Array.isArray(health["problems"])) return null;
  const checked = health["checked_at"];
  return { problems: health["problems"], checked: typeof checked === "string" ? checked : null };
}

/** The machine's problems, failures first, a machine-wide one once, and when they were checked; null when no agent reports
 * health (an older connector: unknown, not fine). */
export function machineProblems(connector: Reported): { problems: MachineProblem[]; checked: string | null } | null {
  const out: MachineProblem[] = [];
  const seen = new Set<string>();
  let reported = false;
  let checked: string | null = null;
  for (const agent of agentsOf(connector)) {
    const health = problemsOf(agent);
    if (!health) continue;
    reported = true;
    if (health.checked !== null && (checked === null || health.checked > checked)) checked = health.checked;
    for (const raw of list(health.problems).slice(0, HEALTH_READ_MAX)) {
      const problem = objOrNull(raw);
      const code = problem?.["code"];
      if (!problem || typeof code !== "string" || !CODE.test(code)) continue;
      const machineWide = problem["scope"] === "machine";
      const key = JSON.stringify([
        machineWide ? null : pyStr(agent["agent_id"]),
        code,
        slice(orEmpty(problem["detail"]), 0, 200),
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        agent: machineWide ? null : agent,
        code,
        fail: problem["severity"] !== "warn",
        detail: problem["detail"],
        fix: problem["fix"],
      });
    }
  }
  if (!reported) return null;
  return { problems: [...out.filter((p) => p.fail), ...out.filter((p) => !p.fail)], checked };
}

type HealthWord = string | ((p: { agent: string }) => string);

/** Our words for a connector's problem code (`agent_not_signed_in`), with `who` filled in; null for a code we have none for. */
function healthWords(code: string, who: string, lang: Lang): string | null {
  const words: Readonly<Record<string, HealthWord>> = remoteHealthText.in(lang);
  const key = code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const word = Object.hasOwn(words, key) ? words[key] : undefined;
  if (word === undefined) return null;
  return typeof word === "string" ? word : word({ agent: who });
}

function problemLine(problem: MachineProblem, lang: Lang): string {
  const who = problem.agent ? neutral(problem.agent["name"], 40) || kindLabel(problem.agent["kind"]).label : "";
  const what = healthWords(problem.code, plain(who), lang) ?? lit(orEmpty(problem.detail) || problem.code, 160);
  const fix = neutral(problem.fix, 160).replaceAll("`", "'");
  const mark = problem.fail ? "⛔" : "⚠️";
  if (!fix) return `${mark} ${what}`;
  if (COMMAND_FIX.test(fix)) return `${mark} ${what}${remoteText.in(lang).runOnMachine({ fix })}`;
  return `${mark} ${what}${remoteText.in(lang).fixWords({ fix: plain(fix) })}`;
}

/** One line per problem of the machine (at most HEALTH_LINES_MAX, then how many more): what is wrong and the command that fixes it
 * on that machine. [] when it reports none or no health at all. */
export function healthLines(connector: Reported, lang: Lang = "en"): string[] {
  const found = machineProblems(connector);
  if (!found) return [];
  const lines = found.problems.slice(0, HEALTH_LINES_MAX).map((p) => problemLine(p, lang));
  if (found.problems.length > HEALTH_LINES_MAX) {
    lines.push(remoteText.in(lang).moreProblems({ n: found.problems.length - HEALTH_LINES_MAX }));
  }
  return lines;
}
