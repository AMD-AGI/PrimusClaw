// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawAnswerInvalid, ClawError, ClawUnreachable, errorKind } from "../claw/errors.js";
import type { JsonObject } from "../json.js";
import { OBSERVE_TEXT as T } from "../locales/observe.js";
import type { ClawAssistantPort } from "../ports/claw/assistant.js";
import type { Logger } from "../ports/logger.js";
import type { ObserveRepository } from "../ports/store/observe.js";
import { textMessage, type Conversation } from "../ports/surface.js";
import { pyJsonDumps, pyStr } from "../text/py-text.js";
import { NOT_SUGGESTIONS, describe, toolOf } from "./suggestions.js";
import { suggestionMessage } from "./views.js";

/**
 * The suggestions of the groups a person observes, after their /board: one card each with Accept and Dismiss; what they
 * accepted or dismissed is not offered again. Nothing at all when they observe no group.
 */

/** The record of this many of the person's observed groups is read, newest first. */
const GROUPS_READ = 5;
/** Messages of each group's record read. */
const RECORD_READ = 20;
/** Suggestion cards one /board sends. */
const SUGGESTIONS_SHOWN = 3;

export interface BoardDeps {
  readonly observe: ObserveRepository;
  readonly assistant: Pick<ClawAssistantPort, "observations">;
  readonly log: Logger;
}

interface Pending {
  readonly conversationId: string;
  readonly group: string;
  readonly runId: string;
  readonly seq: number;
  readonly tool: string;
  readonly args: unknown;
  readonly message: string;
}

export class ObserveBoard {
  constructor(private readonly deps: BoardDeps) {}

  async show(userId: string, key: string, conversation: Conversation): Promise<void> {
    const groups = this.deps.observe.observedBy(userId);
    if (groups.length === 0) return;
    const pending: Pending[] = [];
    for (const group of groups.slice(0, GROUPS_READ)) {
      const record = await this.record(key, group.scope);
      for (const row of record) pending.push(...this.suggestionsOf(userId, group.conversationId, group.name, row));
    }
    if (pending.length === 0) {
      const on = groups.filter((g) => g.on).length;
      await conversation.send(textMessage(T.noSuggestions({ on })));
      return;
    }
    for (const item of pending.slice(0, SUGGESTIONS_SHOWN)) {
      const { kind, what } = describe(item.tool, item.args);
      const cardId = this.deps.observe.addObserveCard({
        userId,
        conversationId: item.conversationId,
        runId: item.runId,
        seq: item.seq,
        tool: item.tool,
        args: pyJsonDumps(item.args),
        message: item.message,
      });
      await conversation.send(suggestionMessage({ cardId, group: item.group, message: item.message, kind, what }));
    }
    if (pending.length > SUGGESTIONS_SHOWN) {
      await conversation.send(textMessage(T.moreSuggestions({ more: pending.length - SUGGESTIONS_SHOWN })));
    }
  }

  /** A group's record; one that cannot be read is left out of this board. */
  private async record(key: string, scope: string): Promise<readonly JsonObject[]> {
    try {
      return await this.deps.assistant.observations(key, scope, RECORD_READ);
    } catch (err) {
      if (!(err instanceof ClawError || err instanceof ClawUnreachable || err instanceof ClawAnswerInvalid)) throw err;
      this.deps.log.info("observe: a group's record was not read for the board", { why: errorKind(err) });
      return [];
    }
  }

  /** The calls of one recorded message that are suggestions and are not settled yet. */
  private suggestionsOf(userId: string, conversationId: string, group: string, row: JsonObject): Pending[] {
    const runId = pyStr(row["run_id"]);
    const would = Array.isArray(row["would"]) ? row["would"] : [];
    const out: Pending[] = [];
    would.forEach((call, seq) => {
      const fields = typeof call === "object" && call !== null && !Array.isArray(call) ? (call as JsonObject) : {};
      const tool = toolOf(fields["tool"]);
      if (!runId || !tool || NOT_SUGGESTIONS.has(tool)) return;
      if (this.deps.observe.observeSuggestionSettled(userId, runId, seq)) return;
      out.push({ conversationId, group, runId, seq, tool, args: fields["args"], message: pyStr(row["message"]) });
    });
    return out;
  }
}
