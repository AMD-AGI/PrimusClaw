// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a chat shows while a turn runs: the agent's own short lines between tool calls, and at most one line for the step
 * running now.
 *
 * The lines are the main agent's visible text (one per step) and a "⚠️ ... failed, continuing" line for a step that
 * failed. The step running now is one "⏳ <label>" line at the end, replaced in place by the next step and gone when the
 * step is over: a finished step leaves nothing, so the view never grows a list of tools. The label is humanized (never a
 * raw tool name) and consecutive repeats of the same step collapse into one line with a count. Every line is its own
 * paragraph, because Teams runs lines that are only separated by a single newline together.
 *
 * Hidden reasoning, subagent text and tool inputs never reach this class (TurnState.feed does not put them on a Step).
 * The view is bounded: `render` keeps the newest blocks that fit LIVE_MAX_CHARS. Brain's setup steps are not steps: while
 * setup is running `preparing` adds one transient line at the end, and a setup step that failed is one line per name. The
 * agent's own checklist (`todo_write`) sits under the header with a budget of its own.
 */

import { type Lang, toLang } from "../locales/lang.js";
import { turnEnglish, turnText } from "../locales/turn.js";
import { collapseSpaces, pyLen, pyLstrip, pyRstrip, pySlice, pyStrip } from "../text/python-str.js";
import { planHead, planText, type Todo } from "./plan.js";
import type { Step } from "./step.js";
import { failedLine, type Label, labelFor } from "./upstream.js";

export const LIVE_HEADER = turnText.in("en").liveHeader;
/** The progress message's first line, in the person's language. */
export const LIVE_HEADERS: Readonly<Record<Lang, string>> = { en: LIVE_HEADER, zh: turnText.in("zh").liveHeader };
/** The live view of a running turn: only the newest part, well under Teams' limit. */
export const LIVE_MAX_CHARS = 2500;
/** A long turn does not grow the view without bound. */
export const LIVE_KEEP_BLOCKS = 40;
export const LIVE_TOOL_NAME_MAX = 60;
/** The one line of the step that is running now. */
export const RUNNING_MARK = "⏳";
export const PREPARING_LINE = turnText.in("en").preparing;
/** The agent's newest line in a floating status (a 1:1 chat) is clipped to this. */
export const STATUS_NARRATION_MAX = 200;
const TOOL_DONE: ReadonlySet<string> = new Set(["success", "error"]);

export function preparationFailureLine(name: string, count = 1): string {
  return turnEnglish.couldNotLoad(name, count);
}

/** The last item of `items` that `test` takes (`Array.prototype.findLast` is past this build's target). */
function findLast<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && test(item)) return item;
  }
  return undefined;
}

/** Labels are values: two with the same words are the same label. */
function sameLabel(a: Label, b: Label): boolean {
  return a.one === b.one && a.many === b.many;
}

type Block =
  | { kind: "text"; body: string }
  | { kind: "failed"; label: Label; count: number }
  | { kind: "load_failed"; name: string; count: number };

/** A step in flight: Brain's id of the call (undefined: none), the tool's name, its label. */
interface Running {
  readonly actionId: string | undefined;
  readonly name: string;
  label: Label;
}

export class LiveView {
  /** The first line of every render (a subclass names what is working). */
  header: string;
  /** Setup is running: one transient line at the end. */
  preparing = false;
  private todos: readonly Todo[] = [];
  private blocks: Block[] = [];
  private running: Running[] = [];
  /** The newest step, and how often in a row it has started. */
  private group: { label: Label; count: number } | undefined;

  constructor(readonly lang: string = "en") {
    this.header = turnText.in(toLang(lang)).liveHeader;
  }

  /** Fold one step in; true when what `render` returns changed. */
  apply(step: Step): boolean {
    const before = this.render();
    if (step.todos !== undefined) this.todos = [...step.todos];
    if (step.narration) {
      this.blocks.push({ kind: "text", body: step.narration });
      this.running = []; // the agent speaks once its tools are done; a finish that never came must not pin a line
      this.group = undefined;
    } else if (step.tool) {
      const name = pySlice(collapseSpaces(step.tool[0]) || "tool", 0, LIVE_TOOL_NAME_MAX);
      const status = step.tool[1];
      if (step.preparation) this.loadFailed(name);
      else if (TOOL_DONE.has(status)) this.finish(step, name, status);
      else this.start(step, name);
    }
    this.blocks = this.blocks.slice(-LIVE_KEEP_BLOCKS);
    return this.render() !== before;
  }

  /** Only a failed setup step gets here: one line per name, with a count. */
  private loadFailed(name: string): void {
    const failed = findLast(this.blocks, (b) => b.kind === "load_failed" && b.name === name);
    if (failed && failed.kind === "load_failed") failed.count += 1;
    else this.blocks.push({ kind: "load_failed", name, count: 1 });
  }

  private start(step: Step, name: string): void {
    const label = labelFor(name, step.skill, this.lang);
    const again = step.actionId ? this.running.find((e) => e.actionId === step.actionId) : undefined;
    if (again) {
      // the same step reported again: its label may now be better known, it is not a repeat
      if (this.group && sameLabel(this.group.label, again.label)) this.group.label = label;
      again.label = label;
      return;
    }
    if (this.group && this.group.label.one === label.one) this.group.count += 1;
    else this.group = { label, count: 1 };
    this.running.push({ actionId: step.actionId, name, label });
    this.running = this.running.slice(-LIVE_KEEP_BLOCKS);
  }

  private finish(step: Step, name: string, status: string): void {
    const ended = step.actionId
      ? this.running.find((e) => e.actionId === step.actionId)
      : findLast(this.running, (e) => e.name === name);
    if (ended) this.running.splice(this.running.indexOf(ended), 1);
    if (status !== "error") return; // a step that went well leaves no line
    const label = ended ? ended.label : labelFor(name, undefined, this.lang);
    const last = this.blocks.at(-1);
    if (last && last.kind === "failed" && last.label.one === label.one) last.count += 1;
    else this.blocks.push({ kind: "failed", label, count: 1 });
    this.group = undefined;
  }

  private runningLine(): string | undefined {
    const newest = this.running.at(-1);
    if (!newest) return undefined;
    const count = this.group && this.group.label.one === newest.label.one ? this.group.count : 1;
    return `${RUNNING_MARK} ${newest.label.text(count)}`;
  }

  private failedText(block: { label: Label; count: number }): string {
    return failedLine(block.label, this.lang) + (block.count > 1 ? ` (${String(block.count)})` : "");
  }

  private preparingLine(): string {
    return turnText.in(toLang(this.lang)).preparing;
  }

  private paragraphs(): string[] {
    const out = this.blocks.map((block) => {
      if (block.kind === "failed") return this.failedText(block);
      if (block.kind === "load_failed") return preparationFailureLine(block.name, block.count);
      return block.body;
    });
    const line = this.runningLine();
    if (line) out.push(line);
    if (this.preparing) out.push(this.preparingLine());
    return out;
  }

  /**
   * The view as the few short lines of a floating status: in a 1:1 chat (`private`) where the plan stands and the agent's
   * newest line; in every chat a step that failed last and the step running now. A group sees no words of the agent's or
   * of its plan: only the humanized step lines, which come from a fixed list. Nothing yet: [].
   */
  statusLines(isPrivate: boolean): string[] {
    const lines: string[] = isPrivate ? this.privateLines() : [];
    const last = this.blocks.at(-1);
    if (last && last.kind === "failed") lines.push(this.failedText(last));
    const line = this.runningLine();
    if (line) lines.push(line);
    else if (this.preparing) lines.push(this.preparingLine());
    return lines;
  }

  private privateLines(): string[] {
    const lines: string[] = [];
    const live = this.todos.filter((t) => t[1] !== "cancelled");
    if (live.length) {
      const done = live.filter((t) => t[1] === "completed").length;
      lines.push(pyStrip(planHead(this.lang, done, live.length), "*"));
    }
    const said = findLast(this.blocks, (b) => b.kind === "text");
    if (said && said.kind === "text") {
      const flat = collapseSpaces(said.body.replaceAll("**", "").replaceAll("`", ""));
      lines.push(
        pyLen(flat) <= STATUS_NARRATION_MAX ? flat : `${pyRstrip(pySlice(flat, 0, STATUS_NARRATION_MAX - 1))}…`,
      );
    }
    return lines;
  }

  render(): string {
    const plan = planText(this.todos, this.lang);
    const budget = LIVE_MAX_CHARS - (plan ? pyLen(plan) + 2 : 0); // the plan keeps its place; the lines get the rest
    let body = "";
    let clipped = false;
    for (const paragraph of this.paragraphs().reverse()) {
      const joined = body ? `${paragraph}\n\n${body}` : paragraph;
      if (pyLen(joined) <= budget) {
        body = joined;
        continue;
      }
      clipped = true;
      if (!body) body = pyLstrip(pySlice(paragraph, -budget)); // the newest paragraph alone is too long: keep its end
      break;
    }
    if (clipped) body = `...\n\n${body}`;
    if (body.split("```").length % 2 === 0) {
      // a cut or unfinished code fence would swallow the rest of the message
      body = clipped ? `\`\`\`\n${body}` : `${body}\n\`\`\``;
    }
    return [this.header, plan, body].filter((part) => part).join("\n\n");
  }
}
