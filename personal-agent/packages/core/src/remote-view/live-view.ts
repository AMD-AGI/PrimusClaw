// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a chat shows while a remote agent works: its own text as it streams, its thoughts as dim italic lines, one line for the
 * plan, a line for a step that failed and one running line for the step running now. Bounded like Claw's own live view (the
 * newest part that fits is kept). Credentials are masked at render time over the whole text, so a secret split across two
 * chunks is still caught.
 */
import type { RemoteStep } from "../remote/events.js";
import { splitErrorTail } from "../public-error/classify.js";
import { masked as redactText, neutral } from "../remote/inert.js";
import type { Lang } from "../locales/lang.js";
import { ACTIVE_STEPS_MAX, BLOCK_KEEP_CHARS, THOUGHT_MAX, TOOL_TITLE_MAX } from "../remote/limits.js";
import { cpLength, cpSlice, pyLstrip, pyStrip, squashSpaces } from "../text/py-text.js";
import { remoteText } from "../locales/remote.js";

/** The live view of a turn shows at most this much below its header. */
export const LIVE_MAX_CHARS = 2500;
/** Blocks a live view keeps (a long turn does not grow it without bound). */
export const LIVE_KEEP_BLOCKS = 40;
/** The mark of the one line of the step that is running now. */
export const RUNNING_MARK = "⏳";

type BlockKind = "message" | "thought" | "failed" | "plan" | "note";
interface Block {
  readonly kind: BlockKind;
  text: string;
}

const STYLE_CHARS = /[*_`~]/g;

/** The newest paragraphs that fit `budget` characters, "..." when older ones were left out, and an unclosed code fence closed. */
export function boundedBody(paragraphs: readonly string[], budget: number): string {
  let body = "";
  let clipped = false;
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const paragraph = paragraphs[i] ?? "";
    const joined = body ? `${paragraph}\n\n${body}` : paragraph;
    if (cpLength(joined) <= budget) {
      body = joined;
      continue;
    }
    clipped = true;
    if (!body) body = pyLstrip(cpSlice(paragraph, -budget));
    break;
  }
  if (clipped) body = `...\n\n${body}`;
  if (body.split("```").length % 2 === 0) body = clipped ? `\`\`\`\n${body}` : `${body}\n\`\`\``;
  return body;
}

/** Whether a step is something of the turn itself (its words, a step, a question, its start or end, what was typed at the
 * terminal): once one shows, the message no longer waits for the terminal. */
function showsTheTurn(step: RemoteStep): boolean {
  return (
    step.chunk !== null ||
    step.tool !== null ||
    (step.permission !== null && Object.keys(step.permission).length > 0) ||
    step.finished ||
    step.started ||
    Boolean(step.plan) ||
    step.typed !== null
  );
}

export class RemoteLiveView {
  /** The first line of every render: who is working. */
  readonly header: string;
  private readonly blocks: Block[] = [];
  /** Tool call id -> title of the steps in flight, oldest first. */
  private readonly active = new Map<string, string>();
  /** The next text starts a new block (a tool ran since the last one). */
  private split = true;
  /** Why the message waits, while it waits for a terminal on the machine (`terminal_input_queued`, said in the chat's language by
   * the runner): the floating status says it, not only "Thinking…", until anything of the turn shows. */
  private waiting = "";

  constructor(
    label: string,
    readonly lang: Lang = "en",
  ) {
    this.header = remoteText.in(lang).liveHeader({ label });
  }

  /** Fold one step in; true when what `render` returns changed. */
  apply(step: RemoteStep): boolean {
    const before = this.render();
    const waited = this.waiting;
    if (step.queued !== null) this.waiting = step.note ?? "";
    else if (showsTheTurn(step)) this.waiting = "";
    if (step.chunk) this.addText(step.chunk.kind, step.chunk.text);
    else if (step.tool) this.trackTool(step.tool.id, step.tool.title, step.tool.status);
    else if (step.plan) this.setPlan(step.plan);
    else if (step.note) {
      this.blocks.push({ kind: "note", text: step.note });
      this.split = true;
    }
    this.blocks.splice(0, Math.max(0, this.blocks.length - LIVE_KEEP_BLOCKS));
    return this.render() !== before || this.waiting !== waited;
  }

  /** The few short lines of Teams' floating status while the agent works: why the message still waits for the terminal, where
   * its plan stands, a step that failed last, and the step running now. Its words are streamed into the answer's bubble, not
   * into the status. */
  statusLines(): string[] {
    const lines: string[] = this.waiting ? [this.waiting] : [];
    const plan = this.blocks.find((b) => b.kind === "plan")?.text ?? "";
    if (plan) lines.push(plan);
    const last = this.blocks.at(-1);
    if (last?.kind === "failed")
      lines.push(remoteText.in(this.lang).stepFailed({ title: neutral(last.text, TOOL_TITLE_MAX) }));
    const running = this.runningLine();
    if (running) lines.push(running);
    return lines;
  }

  /** The header and the newest part of the turn that fits. */
  render(): string {
    const body = boundedBody(this.paragraphs(), LIVE_MAX_CHARS);
    return [this.header, body].filter((part) => part).join("\n\n");
  }

  private addText(kind: "message" | "thought", text: string): void {
    const last = this.blocks.at(-1);
    if (last && last.kind === kind && !this.split) {
      last.text = cpSlice(last.text + text, -BLOCK_KEEP_CHARS);
    } else {
      this.blocks.push({ kind, text: cpSlice(pyLstrip(text), -BLOCK_KEEP_CHARS) });
      this.split = false;
    }
  }

  private trackTool(id: string, title: string, status: string): void {
    if (status === "completed" || status === "failed") {
      const known = this.active.get(id) ?? "";
      this.active.delete(id);
      if (status === "failed")
        this.blocks.push({ kind: "failed", text: title || known || remoteText.in(this.lang).aStep });
    } else {
      // (a known id keeps its place: the newest in flight is the one that started last)
      this.active.set(id, title || this.active.get(id) || remoteText.in(this.lang).aStep);
      for (const oldest of this.active.keys()) {
        if (this.active.size <= ACTIVE_STEPS_MAX) break;
        this.active.delete(oldest);
      }
    }
    this.split = true;
  }

  private setPlan(line: string): void {
    const plan = this.blocks.find((b) => b.kind === "plan");
    if (plan) plan.text = line;
    else this.blocks.push({ kind: "plan", text: line });
  }

  private runningLine(): string | null {
    const titles = [...this.active.values()];
    const newest = titles.at(-1);
    return newest === undefined ? null : `${RUNNING_MARK} ${neutral(newest, TOOL_TITLE_MAX)}`;
  }

  private paragraph(block: Block): string {
    switch (block.kind) {
      case "message": // (the raw error of a failed model call is cut off here as in the answer)
        return pyStrip(splitErrorTail(redactText(block.text)).kept);
      case "thought": {
        const flat = squashSpaces(redactText(block.text).replace(STYLE_CHARS, " "));
        const clipped = cpLength(flat) <= THOUGHT_MAX ? flat : "…" + pyLstrip(cpSlice(flat, -(THOUGHT_MAX - 1)));
        return pyStrip(clipped) ? `_\u{1f4ad} ${pyStrip(clipped)}_` : "";
      }
      case "failed":
        return remoteText.in(this.lang).stepFailed({ title: neutral(block.text, TOOL_TITLE_MAX) });
      default:
        return block.text;
    }
  }

  private paragraphs(): string[] {
    const out = this.blocks.map((b) => this.paragraph(b)).filter((p) => p);
    const running = this.runningLine();
    if (running) out.push(running);
    return out;
  }
}
