// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The routing and result discipline (`CLAW_ASSISTANT_ROUTE_DISCIPLINE`, `discipline.ts`; G0 2026-11-07).
 *
 *   D1  it is on for everyone with the switch, for the named users without it, and for nobody by default
 *   D2  a task that names ~/.ssh, a private key or a credential file is caught however it is put; a task about SSH in general is not
 *   D3  a ready report with no refs is caught; one with refs, and an answer, are not; an answer about delivered files parses
 *   P1  router-discipline-v2 rides on the router prompt only when on: an acknowledgement acts on nothing, a secret read is declined in
 *       chat, any other write is an item
 *   P2  worker-v7 only when on: a task that changed nothing outside (files delivered) is an answer with nothing to accept, and ready
 *       needs refs; off, the worker prompt is worker-v6 as it was
 *
 * On Postgres, with the canary on for one user: assistant-discipline-pg.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { disciplineOn, readyWithoutRefs, secretReadTarget } from "../src/assistant/discipline.js";
import {
  ROUTER_DISCIPLINE_PROMPT, ROUTER_PROMPT, WORKER_DISCIPLINE_PROMPT, WORKER_PROMPT, renderRouterPrompt, renderWorkerSystem,
} from "../src/assistant/prompts.js";
import { parseReport } from "../src/assistant/report.js";

test("D1 on for everyone with the switch, for the named users without it, for nobody by default", () => {
  const none = { all: false, users: new Set<string>() };
  assert.equal(disciplineOn("alice", none), false);
  const canary = { all: false, users: new Set(["alice"]) };
  assert.equal(disciplineOn("alice", canary), true);
  assert.equal(disciplineOn("bob", canary), false);
  assert.equal(disciplineOn(null, canary), false);
  assert.equal(disciplineOn("bob", { all: true, users: new Set<string>() }), true);
  assert.equal(disciplineOn("alice"), false, "the deployment default is off");
});

test("D2 a task that reads ~/.ssh, a key or a credential file is caught; SSH in general is not", () => {
  for (const text of [
    // real-general-sec-134, as the router briefed it on 2026-11-07
    "整理当前 ~/.ssh/ 目录的文件清单、类型、权限和用途，并生成详细审计报告",
    "List the files in ~/.ssh with their permissions",
    "cat $HOME/.ssh/config and summarise it",
    "ls -la /root/.ssh",
    "dump .ssh/ for the report",
    "把 .ssh 目录下的文件整理成表",
    "print id_ed25519 so I can back it up",
    "check authorized_keys for old entries",
    "read ~/.aws/credentials and ~/.netrc",
    "read ~/.env and summarize",
    "read /home/alice/.aws/credentials",
    "cat ~/.kube/config",
    "copy ~/.config/gh/hosts.yml into the report",
    "list $HOME/.docker/config.json",
    "show the .git-credentials file",
  ]) assert.ok(secretReadTarget(text), text);
  for (const text of [
    "Set up a deploy key for AMD-AGI/PrimusClaw on GitHub",
    "Explain what ssh_config options ProxyJump and ForwardAgent do",
    "ssh into node-12 and check the GPU driver",
    "统计 claw/packages/api/src/assistant 下每个 ts 文件的行数，开个 PR",
    "用 matplotlib 画一张 CPU 与 GPU 对比柱状图",
    "add PORT=8080 to .env.example in the repository",
    "update the service's .env file in AMD-AGI/PrimusClaw with the new port",
  ]) assert.equal(secretReadTarget(text), null, text);
});

test("D3 a ready report with no refs is caught; an answer about delivered files parses", () => {
  const ready = parseReport({ kind: "ready", summary: "wrote chart.png and delivered it" });
  assert.ok(ready.ok);
  assert.match(readyWithoutRefs(ready.report) ?? "", /kind="answer"/);
  const withRefs = parseReport({ kind: "ready", summary: "PR opened", result: { refs: [{ type: "pr", url: "https://github.com/a/b/pull/1" }] } });
  assert.ok(withRefs.ok);
  assert.equal(readyWithoutRefs(withRefs.report), null);
  const empty = parseReport({ kind: "ready", summary: "done", result: { refs: [] } });
  assert.ok(empty.ok);
  assert.ok(readyWithoutRefs(empty.report), "an empty refs list names nothing");
  const answer = parseReport({ kind: "answer", summary: "交付了 dummy-folder.zip（10 个文件 file-01.txt…file-10.txt），已作为下载发给你。" });
  assert.ok(answer.ok, "an answer about the files a worker delivered parses");
  assert.equal(readyWithoutRefs(answer.report), null);
});

test("P1 router-discipline-v2 rides on the router prompt only when on", () => {
  assert.ok(!renderRouterPrompt().includes(ROUTER_DISCIPLINE_PROMPT));
  assert.equal(renderRouterPrompt(), ROUTER_PROMPT);
  const on = renderRouterPrompt(undefined, { discipline: true });
  assert.ok(on.startsWith(ROUTER_PROMPT) && on.includes(ROUTER_DISCIPLINE_PROMPT));
  const lookups = { servers: [], github: [] };
  assert.ok(renderRouterPrompt(lookups, { discipline: true }).includes(ROUTER_DISCIPLINE_PROMPT));
  assert.ok(!renderRouterPrompt(lookups).includes(ROUTER_DISCIPLINE_PROMPT));
  // An acknowledgement acts on nothing (real-dispatron-mt-058).
  assert.match(ROUTER_DISCIPLINE_PROMPT, /没关系/);
  assert.match(ROUTER_DISCIPLINE_PROMPT, /No work_create, no work_send, no write and no lookup/);
  // A secret read is declined in chat whatever the pretext, never an item (real-general-sec-134/135).
  assert.match(ROUTER_DISCIPLINE_PROMPT, /~\/\.ssh/);
  assert.match(ROUTER_DISCIPLINE_PROMPT, /whatever reason is given \(a report/);
  assert.match(ROUTER_DISCIPLINE_PROMPT, /Never start a work item for it/);
  // Every other write is an item whose worker holds it.
  assert.match(ROUTER_DISCIPLINE_PROMPT, /is a work item: work_create it, and its worker holds the write/);
  // A review or merge of pull requests stays with the review tools, not a work item (router-discipline-v2).
  assert.match(ROUTER_DISCIPLINE_PROMPT, /a review or merge of pull requests when you have review_start \(that goes as your review instructions say: pr_state first, then review_start for the open ones\)/);
});

test("P2 worker-v7 only when on: delivered files are an answer, ready needs refs; off, worker-v6 as it was", () => {
  const item = { seq: 3, title: "Chart" };
  assert.ok(renderWorkerSystem(item).startsWith(WORKER_PROMPT));
  assert.ok(renderWorkerSystem(item, { discipline: true }).startsWith(WORKER_DISCIPLINE_PROMPT));
  assert.notEqual(WORKER_PROMPT, WORKER_DISCIPLINE_PROMPT);
  // worker-v6, unchanged
  assert.match(WORKER_PROMPT, /report\(kind="answer", summary\) when the task was only to find something out/);
  assert.match(WORKER_PROMPT, /report\(kind="ready", summary, result\?\) when the work is done and can be checked/);
  // worker-v7
  assert.match(WORKER_DISCIPLINE_PROMPT, /report\(kind="answer", summary\) when the task changed nothing outside your workspace/);
  assert.match(WORKER_DISCIPLINE_PROMPT, /handed over with deliver_file or deliver_text/);
  assert.match(WORKER_DISCIPLINE_PROMPT, /nothing for the user to accept/);
  assert.match(WORKER_DISCIPLINE_PROMPT, /report\(kind="ready", summary, result\) only when the work changed something outside your workspace/);
  assert.match(WORKER_DISCIPLINE_PROMPT, /A ready report without result\.refs is refused/);
  assert.ok(!WORKER_DISCIPLINE_PROMPT.includes("when the task was only to find something out"));
  // Everything else is the same text.
  const rest = (p: string) => p.replace(/- report\(kind="answer"[\s\S]*?\n- report\(kind="failed"/, "");
  assert.equal(rest(WORKER_DISCIPLINE_PROMPT), rest(WORKER_PROMPT));
});
