// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { defineCatalog } from "./catalog.js";

/**
 * The live line a running tool step gets (`step-labels/`). Each step kind has its line for one step and, where it
 * differs, for the same step repeated (`…Many`; "Reading files (3)").
 */
export const stepText = defineCatalog({
  en: {
    read: "Reading a file",
    readMany: "Reading files",
    edit: "Editing a file",
    editMany: "Editing files",
    shell: "Running a command",
    shellMany: "Running commands",
    search: "Searching files",
    searchMany: "",
    web: "Looking something up online",
    webMany: "",
    task: "Running a sub-task",
    taskMany: "Running sub-tasks",
    board_read: "Reading a board topic",
    board_readMany: "Reading board topics",
    safe: "Querying SaFE",
    safeMany: "",
    /** `what`: the words of what is listed (the Chinese line says "the lists"). */
    boardList: (p: { what: string }) => `Listing board ${p.what}`,
    boardListed: "",
    skill: (p: { skill: string }) => `Using the ${p.skill} skill`,
    generic: (p: { what: string }) => `Working: ${p.what}`,
    failed: (p: { label: string }) => `⚠️ ${p.label} failed, continuing`,
    safeLookup: (p: { what: string }) => `Checking SaFE ${p.what}`,
    serverLookup: (p: { server: string }) => `Querying ${p.server}`,
  },
  zh: {
    read: "读取文件",
    readMany: "",
    edit: "修改文件",
    editMany: "",
    shell: "执行命令",
    shellMany: "",
    search: "搜索文件",
    searchMany: "",
    web: "在线查询",
    webMany: "",
    task: "执行子任务",
    taskMany: "",
    board_read: "读取看板话题",
    board_readMany: "",
    safe: "查询 SaFE",
    safeMany: "",
    boardList: (p) => `查看看板${p.what}`,
    boardListed: "列表",
    skill: (p) => `使用 ${p.skill} 技能`,
    generic: (p) => `处理中：${p.what}`,
    failed: (p) => `⚠️ ${p.label}失败，已继续`,
    safeLookup: (p) => `查询 SaFE ${p.what}`,
    serverLookup: (p) => `查询 ${p.server}`,
  },
});

/** What a SaFE read of the assistant is about, by the first word of its name (`node_list` -> nodes): [en, zh]. */
export const SAFE_OBJECTS: Readonly<Record<string, readonly [string, string]>> = {
  node: ["nodes", "节点"],
  cluster: ["clusters", "集群"],
  workload: ["workloads", "工作负载"],
  workspace: ["workspaces", "工作空间"],
  flavor: ["flavors", "规格"],
  opsjob: ["ops jobs", "运维任务"],
  user: ["your account", "账号"],
};

/** The assistant's own tools (`mcp__assistant__*`), by what the person sees it do: [en, zh]. */
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
