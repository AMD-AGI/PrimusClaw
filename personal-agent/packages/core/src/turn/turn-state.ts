// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One turn's view of a session's stream. `feed` is pure apart from the state it keeps: it consumes one event and returns
 * what the runner should do, so the mapping is testable without any network.
 */

import { collapseSpaces, pySlice, pyStrip } from "../text/python-str.js";
import { type Delivery, deliveryOf } from "./deliveries.js";
import { type GithubOutcome, githubPrSummary, githubResult, githubWrite, reviewComments } from "./github-outcome.js";
import { isObject, type JsonObject, objectOr, textOf, truthy } from "./json.js";
import { todosOf } from "./plan.js";
import { type ModelRefusalPolicy, noModelRefusalPolicy } from "../plugins/model-refusal-policy.js";
import { NOTHING, type Step } from "./step.js";
import {
  HISTORY_COMPLETE,
  isShell,
  looksLikeFailure,
  QUEUED_PREFIX,
  skillInCommand,
  type SseEvent,
} from "./upstream.js";

/** Brain's setup steps before the first model call: never listed as steps, one "Preparing" line while it takes long. */
export const PREPARATION_TOOLS: ReadonlySet<string> = new Set([
  "resolve_tools",
  "download_skill",
  "load_mcp",
  "load_rule",
  "load_hooks",
]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["stopped", "failed"]);
const TOOL_DONE: ReadonlySet<string> = new Set(["success", "error"]);
/** Events only the main agent's count: a subagent's text, deltas and result are not the turn's. */
const MAIN_AGENT_ONLY: ReadonlySet<string> = new Set(["AssistantMessage", "chatDelta", "ResultMessage"]);

/** Which turn an event belongs to: `data.message_id`, else `data.data.message_id` (undefined: none said). */
export function messageIdOf(data: JsonObject): unknown {
  const own = data["message_id"];
  return truthy(own) ? own : objectOr(data["data"])["message_id"];
}

/** The shell command of a toolUsed event, wherever this Brain puts it (`argumentsDetail: {tool: {command}}`). */
function commandOf(data: JsonObject, tool: string): string | undefined {
  for (const source of [data["argumentsDetail"], data["input"]]) {
    const nested = isObject(source) ? source[tool] : undefined;
    const args = isObject(nested) ? nested : source;
    if (isObject(args) && typeof args["command"] === "string") return args["command"];
  }
  return undefined;
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b): b is JsonObject => isObject(b) && b["type"] === "text")
    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
    .join("");
}

export class TurnState {
  /** Ids of the events seen: a reconnect's replay is not taken in twice. */
  private readonly seen = new Set<string>();
  /** Queued only: ids of the turns that came before the message. */
  private readonly replayed = new Set<unknown>();
  /** Queued only: the history replay is over. */
  private live = false;
  /** Queued only: the replay reached `behind`; what follows is newer. */
  private passed = false;
  private started = false;
  text = "";
  finalText = "";
  /** The main agent's text deltas of the model turn being written; '' once it is whole. */
  partial = "";
  /** The files the agent delivered in this turn, in order. */
  readonly deliveries: Delivery[] = [];
  /** The model the gateway says served the turn's latest answer ('' not said). */
  routedModel = "";
  /** Each review or merge the turn wrote to GitHub; one list for the turn (a fallback run shares it). */
  writes: GithubOutcome[] = [];
  /** Every finished call of the GitHub write tools, whatever it did. */
  readonly results: GithubOutcome[] = [];
  /** The inline comments of the reviews the turn posted. */
  comments = 0;
  /** The latest sentence of what the pull request does a review or merge call gave. */
  prSummary = "";
  /** How Claw ended the turn; undefined: not yet. */
  failed: boolean | undefined = undefined;

  /**
   * @param messageId undefined: Claw queued the message; its turn is the first queue-run turn newer than `behind`.
   * @param behind queued only: the turn Claw was running when the message was sent (undefined: unknown).
   * @param first queued only: the session is new and this is its first turn.
   */
  constructor(
    public messageId: string | undefined,
    readonly behind?: string,
    readonly first = false,
    private readonly refusals: ModelRefusalPolicy = noModelRefusalPolicy,
  ) {}

  get answer(): string {
    return this.finalText || this.text;
  }

  /**
   * A queued message has no id yet. Claw runs it as `claw-pending-<n>`, a turn that starts after the one in front of it
   * (`behind`). So it is the first such id newer than that turn: after `behind` in the replay, else the first one to
   * start live. Turns that came before (older ones, `behind` itself) are never it.
   */
  private adopt(event: SseEvent): void {
    if (event.name === HISTORY_COMPLETE) {
      this.live = true;
      return;
    }
    const eventMessage = messageIdOf(event.data);
    if (this.first && truthy(eventMessage)) {
      this.messageId = textOf(eventMessage);
      return;
    }
    if (!truthy(eventMessage) || eventMessage === this.behind) {
      this.passed = this.passed || truthy(eventMessage);
      return;
    }
    if (this.live || this.passed) {
      const id = textOf(eventMessage);
      if (id.startsWith(QUEUED_PREFIX) && !this.replayed.has(eventMessage)) this.messageId = id;
    } else {
      this.replayed.add(eventMessage);
    }
  }

  /** Events of this turn only: the stream replays every earlier turn first. */
  private mine(data: JsonObject): boolean {
    const eventMessage = messageIdOf(data);
    if (this.messageId !== undefined && eventMessage === this.messageId) {
      this.started = true;
      return true;
    }
    return this.started && !truthy(eventMessage);
  }

  feed(event: SseEvent): Step {
    if (event.id && this.seen.has(event.id)) return NOTHING;
    if (event.id) this.seen.add(event.id);
    if (this.messageId === undefined) this.adopt(event);
    const data = event.data;
    if (!this.mine(data)) return NOTHING;
    const mainAgent = !truthy(data["subagent_id"]);
    if (MAIN_AGENT_ONLY.has(event.name) && !mainAgent) return NOTHING;
    return this.step(event.name, data, mainAgent);
  }

  private step(name: string, data: JsonObject, mainAgent: boolean): Step {
    switch (name) {
      case "AssistantMessage":
        return this.assistantMessage(data);
      case "toolUsed":
        return this.toolUsed(data, mainAgent);
      case "chatDelta":
        return this.chatDelta(data);
      case "permissionRequest":
        return truthy(data) ? { approval: data } : NOTHING;
      case "userQuestion":
        return truthy(data) ? { question: data } : NOTHING;
      case "ResultMessage":
        return this.resultMessage(data);
      case "statusUpdate":
        return this.statusUpdate(data);
      case "error":
        this.failed = true;
        return { finished: true, error: true };
      default:
        return NOTHING;
    }
  }

  /** One model turn. Earlier ones are narration between tool calls, so only the last one with text is the answer. */
  private assistantMessage(data: JsonObject): Step {
    const routed = data["routed_model"];
    if (typeof routed === "string" && pyStrip(routed)) this.routedModel = pySlice(collapseSpaces(routed), 0, 100);
    const text = textOfBlocks(objectOr(data["data"])["content"]);
    this.partial = "";
    if (!pyStrip(text)) return NOTHING;
    this.text = text;
    // (the proxy's raw error, or Brain's for a failed model call, is no progress: never shown)
    if (this.refusals.classify(text, undefined) !== undefined || looksLikeFailure(text)) return NOTHING;
    return { narration: pyStrip(text) };
  }

  private noteGithub(tool: string, status: string, description: unknown): void {
    const write = status === "success" ? githubWrite(tool, description) : undefined;
    if (write) this.writes.push(write);
    const outcome = githubResult(tool, status, description);
    if (!outcome) return;
    this.results.push(outcome);
    if (outcome[0] === "gh_review_submit" && outcome[1] === "submitted") this.comments += reviewComments(description);
    const summary = githubPrSummary(tool, description);
    if (summary) this.prSummary = summary;
  }

  private toolUsed(data: JsonObject, mainAgent: boolean): Step {
    const tool = textOf(data["tool"]);
    const status = textOf(data["status"]);
    this.noteGithub(tool, status, data["description"]);
    if (PREPARATION_TOOLS.has(pyStrip(tool))) {
      return status === "error" ? { tool: [tool, status], preparation: true } : { preparation: true };
    }
    const delivery = mainAgent ? deliveryOf(tool, status, data) : undefined;
    if (delivery && this.deliveries.every((d) => d.id !== delivery.id)) this.deliveries.push(delivery);
    const skill = isShell(tool) && !TOOL_DONE.has(status) ? skillInCommand(commandOf(data, tool)) : undefined;
    const actionId = pyStrip(textOf(data["actionId"])) || undefined;
    const todos = todosOf(tool, status, data);
    return {
      tool: [tool, status],
      ...(actionId ? { actionId } : {}),
      ...(skill ? { skill } : {}),
      ...(todos ? { todos } : {}),
    };
  }

  /** Text deltas of the model turn being written: only for streaming the text into the answer's bubble. */
  private chatDelta(data: JsonObject): Step {
    const delta = data["delta"];
    const content = isObject(delta) ? delta["content"] : undefined;
    if (typeof content !== "string" || !content) return NOTHING;
    this.partial += content;
    return { partial: this.partial };
  }

  private resultMessage(data: JsonObject): Step {
    const inner = objectOr(data["data"]);
    this.finalText = textOf(truthy(data["final_text"]) ? data["final_text"] : inner["result"]);
    this.failed = Boolean(this.failed) || inner["subtype"] !== "success";
    return { finished: true, error: inner["subtype"] === "error" };
  }

  private statusUpdate(data: JsonObject): Step {
    const status = data["agentStatus"];
    if (typeof status !== "string" || !TERMINAL_STATUSES.has(status)) return NOTHING;
    this.failed = Boolean(this.failed) || status === "failed";
    return { finished: true, error: status === "failed" };
  }
}
