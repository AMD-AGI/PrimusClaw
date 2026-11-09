// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The plan: the agent's todo list in the live view.
 *
 * `todo_write` is the agent's own checklist for the user. Brain answers each call with a toolUsed event whose
 * `argumentsDetail.todo_write.todos` is the whole list AFTER the merge, so the view replaces its copy and never has to
 * merge. Only each item's text and status are read: ids, other fields and every other tool's input stay out of the view.
 */

import { toLang } from "../locales/lang.js";
import { turnText } from "../locales/turn.js";
import { collapseSpaces, pyLen, pyRstrip, pySlice } from "../text/python-str.js";
import { isObject, type JsonObject } from "./json.js";

export const TODO_TOOLS: ReadonlySet<string> = new Set(["todo_write", "todowrite"]);
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
/** Items read from one event; a list longer than this is not a plan a person reads. */
export const TODO_MAX_ITEMS = 100;
/** One item is clipped to this: a phone shows about 40 characters a line. */
export const TODO_ITEM_MAX = 80;
/** A plan with more items than this is folded. */
export const TODO_FULL_MAX = 8;
/** A folded plan shows this many items in progress ... */
export const TODO_FOLD_ACTIVE = 2;
/** ... and this many of the ones that come next. */
export const TODO_FOLD_NEXT = 3;
export const TODO_MARKS: Readonly<Record<TodoStatus, string>> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⬜",
  cancelled: "🚫",
};

/** One item of the plan: its text (one clipped line) and its status. */
export type Todo = readonly [text: string, status: TodoStatus];

/** The plan's count line ("**Plan: 1 of 3 done**"), for the floating status too. */
export function planHead(lang: string, done: number, total: number): string {
  return turnText.in(toLang(lang)).planHead({ done, total });
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

function todoOf(item: unknown): Todo | undefined {
  if (!isObject(item) || typeof item["content"] !== "string") return undefined;
  // (a code fence would swallow the rest of the view)
  let text = collapseSpaces(item["content"].replaceAll("```", "'"));
  if (!text) return undefined;
  if (pyLen(text) > TODO_ITEM_MAX) text = `${pyRstrip(pySlice(text, 0, TODO_ITEM_MAX - 1))}…`;
  const state = item["status"];
  return [text, isTodoStatus(state) ? state : "pending"];
}

/**
 * The agent's list from a `todo_write` toolUsed event; undefined when the event says nothing about it (another tool, a
 * call that failed, no list in the event). An empty list is a list: the agent cleared it. Malformed items are skipped,
 * never raised: an item that is not an object or has no text; a status Brain does not know counts as pending.
 */
export function todosOf(tool: string, status: string, data: JsonObject): Todo[] | undefined {
  if (!TODO_TOOLS.has(collapseSpaces(tool).toLowerCase()) || status !== "success") return undefined;
  const detail = data["argumentsDetail"];
  const inner = isObject(detail) ? detail["todo_write"] : undefined;
  const items = isObject(inner) ? inner["todos"] : undefined;
  if (!Array.isArray(items)) return undefined;
  const todos: Todo[] = [];
  for (const item of items.slice(0, TODO_MAX_ITEMS)) {
    const todo = todoOf(item);
    if (todo) todos.push(todo);
  }
  return todos;
}

function line(todo: Todo | undefined): string {
  return todo ? `${TODO_MARKS[todo[1]]} ${todo[0]}` : "";
}

/** The indices a folded plan shows: the last finished item, the ones in progress and the next few to do. */
function foldedIndices(todos: readonly Todo[]): number[] {
  const indices = todos.map((_, i) => i);
  const active = indices.filter((i) => todos[i]?.[1] === "in_progress");
  const open = indices.find((i) => todos[i]?.[1] === "in_progress" || todos[i]?.[1] === "pending");
  const firstOpen = open ?? todos.length;
  const shown = [
    ...indices.filter((i) => i < firstOpen && todos[i]?.[1] === "completed").slice(-1),
    ...active.slice(0, TODO_FOLD_ACTIVE),
  ];
  const after = active[0] ?? firstOpen - 1;
  shown.push(...indices.filter((i) => i > after && todos[i]?.[1] === "pending").slice(0, TODO_FOLD_NEXT));
  return [...new Set(shown)].sort((a, b) => a - b);
}

/**
 * The plan as the live view shows it: a count line, then one paragraph per item. A plan of more than TODO_FULL_MAX items
 * is folded to the last finished item, the ones in progress, the next few and one line that counts the rest. A plan that
 * is all done is its count line alone; a list with nothing in it to do or done (empty, or all cancelled) is no plan: "".
 */
export function planText(todos: readonly Todo[], lang = "en"): string {
  const words = turnText.in(toLang(lang));
  const live = todos.filter((t) => t[1] !== "cancelled");
  if (live.length === 0) return "";
  const done = live.filter((t) => t[1] === "completed").length;
  if (done === live.length) return words.planAllDone({ total: live.length });
  const head = words.planHead({ done, total: live.length });
  if (todos.length <= TODO_FULL_MAX) return [head, ...todos.map((t) => line(t))].join("\n\n");
  const shown = foldedIndices(todos);
  const shownDone = shown.filter((i) => todos[i]?.[1] === "completed").length;
  const hidden = live.length - shown.length;
  const lines = shown.map((i) => line(todos[i]));
  if (hidden) lines.push(words.planMore({ n: hidden, done: done - shownDone, todo: hidden - (done - shownDone) }));
  return [head, ...lines].join("\n\n");
}
