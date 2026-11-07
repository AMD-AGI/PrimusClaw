// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The routing and result discipline (`CLAW_ASSISTANT_ROUTE_DISCIPLINE`): what the router starts, and what waits for the user's Accept.
 *
 * Its words are in the prompts (router-discipline-v1, worker-v7, `prompts.ts`); what a prompt states is also enforced here, so a model
 * that does not follow it is refused, not believed:
 *
 *  - `secretReadTarget`: work_create refuses a task that would read ~/.ssh, a private key or a credential file. However the request is
 *    put (a report, a study, an audit), the worker would read them in a sandbox that holds the user's own credentials and deliver them
 *    (G0 2026-11-07, real-general-sec-134: a worker listed ~/.ssh and delivered the "audit" as a file).
 *  - `readyWithoutRefs`: a worker's ready report must name what changed outside (a pull request, a commit, a run). A task that changed
 *    nothing outside, whose result is a file it delivered, is an answer and closes by itself; only an external change waits for Accept
 *    (super-agent polish plan Q2, decided 2026-11-05).
 *
 * Opened per user first (`CLAW_ASSISTANT_ROUTE_DISCIPLINE_USERS`, the evaluation identities), then for everyone.
 */
import { CLAW_ASSISTANT_ROUTE_DISCIPLINE, CLAW_ASSISTANT_ROUTE_DISCIPLINE_USERS } from "../config.js";
import type { WorkReport } from "./work-items.js";

export interface DisciplineSettings { all: boolean; users: ReadonlySet<string> }

export const disciplineSettings: DisciplineSettings = { all: CLAW_ASSISTANT_ROUTE_DISCIPLINE, users: CLAW_ASSISTANT_ROUTE_DISCIPLINE_USERS };

/** Whether the discipline is on for this user's router and worker turns. */
export function disciplineOn(userId: string | null | undefined, settings: DisciplineSettings = disciplineSettings): boolean {
  return settings.all || (!!userId && settings.users.has(userId));
}

/** Whether any user has it, so a caller that must look the user up does so only then. */
export function disciplineAnywhere(settings: DisciplineSettings = disciplineSettings): boolean {
  return settings.all || settings.users.size > 0;
}

/**
 * What a task would read that holds the user's secrets: SSH keys and their directory, and the files tools keep credentials in. Matched
 * on the task as the router wrote it (title and brief); the path forms, not the words "ssh" or "key", so a task about SSH in general
 * (set up a deploy key on GitHub, explain ssh_config) is not refused.
 */
const SECRET_PATHS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /(?:~|\$HOME|\$\{HOME\}|\/home\/[^\s/]+|\/root)\s*\/\s*\.ssh\b/i, what: "~/.ssh" },
  { re: /(?:^|[\s"'`(:：，,、])\.ssh\//i, what: "~/.ssh" },
  { re: /(?:^|[\s"'`(/:：，,、])\.ssh(?:\s*(?:目录|文件夹|directory|folder|dir)\b|\s*(?:目录|文件夹))/i, what: "~/.ssh" },
  { re: /\bid_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b/i, what: "a private SSH key" },
  { re: /\bauthorized_keys\b/i, what: "authorized_keys" },
  { re: /(?:~|\$HOME)\s*\/\s*\.(?:aws\/credentials|netrc|git-credentials|docker\/config\.json|kube\/config|gnupg)\b/i, what: "a credential file" },
];

/** The secret a task would read, named for the refusal; null when it names none. */
export function secretReadTarget(text: string): string | null {
  for (const p of SECRET_PATHS) if (p.re.test(text)) return p.what;
  return null;
}

/** The refusal work_create gives such a task: the router is told to decline in chat. */
export function secretReadRefusal(what: string): string {
  return `this task would read ${what}, which holds the user's keys or credentials: no work item reads them, whatever the reason given. `
    + "Decline it in chat in one short line, and offer to explain in general terms what such a directory holds and how its permissions should be set.";
}

/**
 * A ready report that names nothing changed outside: no `result.refs`. With the discipline on it is refused, so the worker reports what it
 * made as an answer (no Accept), or names the pull request, commit or run the user checks.
 */
export function readyWithoutRefs(report: WorkReport): string | null {
  if (report.kind !== "ready") return null;
  const refs = (report.result as { refs?: unknown[] } | undefined)?.refs;
  if (Array.isArray(refs) && refs.length > 0) return null;
  return "a ready report names what it changed outside your workspace in result.refs (a pull request url, a commit sha, a run id), for the user "
    + "to check and accept. When the task changed nothing outside (it found something out, or made files you delivered with deliver_file or "
    + "deliver_text), report kind=\"answer\" with what you made in the summary: the item closes with it and nothing waits for Accept.";
}
