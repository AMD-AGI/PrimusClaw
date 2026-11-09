// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The one line a running step gets in a progress view (step_labels.py), in the person's language, byte for byte. */

import { defineCatalog } from "./catalog.js";

/** A label: `one` for a step, `many` for the same step repeated ("Reading files (3)"); Chinese has one form. */
export const stepText = defineCatalog({
  en: {
    read: "Reading a file",
    reads: "Reading files",
    edit: "Editing a file",
    edits: "Editing files",
    shell: "Running a command",
    shells: "Running commands",
    search: "Searching files",
    web: "Looking something up online",
    task: "Running a sub-task",
    tasks: "Running sub-tasks",
    boardRead: "Reading a board topic",
    boardReads: "Reading board topics",
    safe: "Querying SaFE",
    boardList: (p: { what: string }) => `Listing board ${p.what}`,
    /** "Listing board issues" names what is listed in English. */
    boardListWhat: (p: { verb: string }) => p.verb,
    skill: (p: { skill: string }) => `Using the ${p.skill} skill`,
    generic: (p: { what: string }) => `Working: ${p.what}`,
    failed: (p: { label: string }) => `⚠️ ${p.label} failed, continuing`,
    safeQuery: (p: { what: string }) => `Checking SaFE ${p.what}`,
    query: (p: { server: string }) => `Querying ${p.server}`,
  },
  zh: {
    read: "读取文件",
    reads: "读取文件",
    edit: "修改文件",
    edits: "修改文件",
    shell: "执行命令",
    shells: "执行命令",
    search: "搜索文件",
    web: "在线查询",
    task: "执行子任务",
    tasks: "执行子任务",
    boardRead: "读取看板话题",
    boardReads: "读取看板话题",
    safe: "查询 SaFE",
    boardList: (p) => `查看看板${p.what}`,
    /** Chinese says "the lists". */
    boardListWhat: () => "列表",
    skill: (p) => `使用 ${p.skill} 技能`,
    generic: (p) => `处理中：${p.what}`,
    failed: (p) => `⚠️ ${p.label}失败，已继续`,
    safeQuery: (p) => `查询 SaFE ${p.what}`,
    query: (p) => `查询 ${p.server}`,
  },
});

/** What a SaFE read is about, by the first word of its name (`node_list` -> nodes): (English, Chinese). */
export const SAFE_OBJECTS: Readonly<Record<string, readonly [string, string]>> = {
  node: ["nodes", "节点"],
  cluster: ["clusters", "集群"],
  workload: ["workloads", "工作负载"],
  workspace: ["workspaces", "工作空间"],
  flavor: ["flavors", "规格"],
  opsjob: ["ops jobs", "运维任务"],
  user: ["your account", "账号"],
};

/** The assistant's own tools (`mcp__assistant__*`), by what the person sees it do: (English, Chinese). */
export const ASSISTANT_STEPS: Readonly<Record<string, readonly [string, string]>> = {
  work_create: ["Starting a task", "创建任务"],
  work_send: ["Passing it to the task", "转给任务"],
  work_stop: ["Stopping a task", "停止任务"],
  work_recall: ["Looking at a task", "查看任务"],
  review_start: ["Starting a review", "发起代码评审"],
  review_restart: ["Restarting a review", "重新发起评审"],
  memory_recall: ["Checking what I remember", "查看记忆"],
  memory_save: ["Remembering it", "记下来"],
  confirmation_answer: ["Answering a confirmation", "处理确认"],
};
