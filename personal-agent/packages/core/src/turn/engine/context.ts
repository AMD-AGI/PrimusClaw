// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Everything one turn runs with: who it acts for, what it sends, where it answers, and what it reports back. */

import type { Lang } from "../../locales/lang.js";
import type { PullRef } from "../../claw/model.js";
import type { Integrations } from "../../plugins/integrations.js";
import type { ModelRefusalPolicy } from "../../plugins/model-refusal-policy.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { PublicErrors } from "../../public-error/public-errors.js";
import type { Envelope, FetchedFile, InboundFile, OutMessage, UserRef } from "../../ports/surface.js";
import type { GithubOutcome } from "../github-outcome.js";
import type { TurnClaw, TurnSurface } from "../ports.js";
import type { ClawError } from "../../claw/errors.js";
import { pickLang } from "../../language/detect.js";

/** What the turn is and whom it acts for. Read only by the turn. */
export interface TurnRequest {
  /** The key of the user this turn acts for, and nobody else. */
  readonly key: string;
  /** What the user wrote (the session's title, the language of the answer). */
  readonly text: string;
  readonly idempotencyKey: string;
  readonly publicBaseUrl: string;
  /** The person's message: a live stream answers it (undefined: the turn is shown by an edited message). */
  readonly streamReplyTo?: string;
  /** A group chat: no tool input on cards, approvals are recorded and owner-only. */
  readonly group?: boolean;
  readonly ownerName?: string;
  /** Claw will push this user a run's end and its approvals. */
  readonly notifies?: boolean;
  /** The model this worker pins its sessions to ('' sends none). */
  readonly model?: string;
  /** The model a turn refused for want of a model key is run again on ('' never). */
  readonly fallbackModel?: string;
  /** The user's client never sends the chat's thumbs on: the answer gets thumbs of our own. */
  readonly ownThumbs?: boolean;
  /** A review turn: the id of the user whose GitHub account the session's tools use (always a new session). */
  readonly actingAs?: string;
  /** A review turn: the one pull request the session is bound to. */
  readonly reviewTarget?: PullRef;
  /** A review turn: the requester's own linked key, sent beside `key` as the model key. Never logged. */
  readonly modelKey?: string;
  /** A review turn: the model its request named. */
  readonly reviewModel?: string;
  /** A review turn that may not merge. */
  readonly reviewOnly?: boolean;
  /** A review Claw made itself: its session has its first message queued, so nothing is sent and the turn is followed. */
  readonly attach?: boolean;
  /** That turn's id when Claw said it ('' when not: it is the session's first turn). */
  readonly attachMessageId?: string;
  /** Shown at the top of the progress message from its first post on (a review's acknowledgement). */
  readonly lead?: string;
  /** A review asked in a group: the asker, whom its answer @mentions (nobody else). */
  readonly mention?: UserRef;
  /** (url, branch) a NEW session is bound to; undefined: no repository. */
  readonly repo?: readonly [string, string];
  /** A card with what the session changed follows a finished answer (1:1 chats). */
  readonly showChanges?: boolean;
  /** The message(s) this one quotes, as text for the model ('' none). */
  readonly quote?: string;
  /** `text` with the address behind each of its links; '' when it is `text` itself. */
  readonly sent?: string;
  /** The language the person is answered in (undefined: the language of `text`). */
  readonly lang?: Lang;
  /** What the user sent with the message. */
  readonly files?: readonly InboundFile[];
}

/** What the turn tells its caller as it goes. Each is optional; none of them can fail the turn's answer. */
export interface TurnHooks {
  /** A fresh credential per call (exchanged tokens expire); without it the request's `key`. */
  readonly keyProvider?: () => Promise<string>;
  /**
   * An approval or question is about to be shown, as `envelope`: false when a card for it is already in a chat (the
   * notification got there first), and the turn then shows none. `expiresIn`: the seconds Brain waits for the answer.
   */
  readonly onApproval?: (
    sessionId: string,
    toolUseId: string,
    tool: string,
    expiresIn: number | undefined,
    envelope: Envelope,
  ) => boolean | undefined;
  readonly onApprovalSent?: (sessionId: string, toolUseId: string) => void;
  readonly onApprovalUnsent?: (sessionId: string, toolUseId: string) => void;
  /** (session, "started" | "delivered" | "failed", Claw message id or ''). */
  readonly onTurn?: (sessionId: string, what: "started" | "delivered" | "failed", messageId: string) => void;
  /** Once, when Claw is running this turn's message. */
  readonly onRunning?: () => void;
  /** The "Report a problem" message for a turn that went wrong. */
  readonly reportMessage?: () => OutMessage;
  /**
   * A review turn: (answer, link to the session, model, the GitHub results, inline comments, the PR's one sentence) ->
   * the text posted, the review's one message.
   */
  readonly shapeAnswer?: (
    answer: string,
    link: string,
    model: string,
    results: GithubOutcome[],
    comments: number,
    prSummary: string,
  ) => string;
  /** A review turn: each finished GitHub write as it arrives; the line it returns is shown at the top of the progress. */
  readonly onGithubResult?: (outcome: GithubOutcome, model: string) => string | undefined;
  /** A review asked of someone else that Claw refused as `acting_as_must_be_self`: true when the asker was told. */
  readonly asItem?: () => Promise<boolean>;
  /** Fetches the files the user sent: (the files fetched, [(name, why not)]). */
  readonly fetchFiles?: (
    files: readonly InboundFile[],
  ) => Promise<readonly [FetchedFile[], Array<readonly [string, string]>]>;
  /** (how many) of the message's files did not reach Claw. */
  readonly onFilesDropped?: (count: number) => void;
}

/** The reply style's switches that touch the turn. */
export interface TurnStyle {
  /** The agent's text is streamed into the answer's bubble (1:1 chats). */
  readonly streamText: boolean;
  /** Suggested replies under a finished 1:1 answer. */
  readonly suggestedReplies: boolean;
}

export interface TurnDeps {
  readonly claw: TurnClaw;
  readonly surface: TurnSurface;
  readonly clock: Clock;
  readonly log: Logger;
  readonly refusals: ModelRefusalPolicy;
  /** What a person is told of a failure, and what is kept back for the log. */
  readonly errors: PublicErrors;
  readonly style: TurnStyle;
  /** A deployment's MCP servers, named in progress lines (none: the public build's). */
  readonly integrations?: Integrations;
}

/** What the turn records as it runs, for whoever runs something after it. */
export interface TurnRecord {
  /** undefined: create a session with this message. */
  sessionId: string | undefined;
  /** The model the session is known to have; a turn updates it. */
  sessionModel: string;
  /** The model the turn ran on: what the gateway said served it, else what the session asks for. */
  ranModel: string;
  /** What the turn left on GitHub. */
  wrote: GithubOutcome[];
  /** A review turn: the sentence of what the pull request does. */
  prSummary: string;
  /** What the turn ended with. */
  finalAnswer: string;
  /** A review turn that Claw answered 401: the asker's credentials were not taken. */
  refusal: ClawError | undefined;
  /** The review was asked for again as the reviewer's item, and the asker told. */
  moved: boolean;
  /** Where the files are, for the model (set once they are in the session). */
  filesNote: string;
  /** The files, once fetched (once per turn). */
  fetched: FetchedFile[] | undefined;
  /** The newest event the session held just before this turn's message was sent: the stream is read after it. */
  streamAfter: string | undefined;
}

export interface TurnContext {
  readonly request: TurnRequest;
  readonly hooks: TurnHooks;
  readonly deps: TurnDeps;
  readonly record: TurnRecord;
}

export function newRecord(sessionId: string | undefined, sessionModel = ""): TurnRecord {
  return {
    sessionId,
    sessionModel,
    ranModel: "",
    wrote: [],
    prSummary: "",
    finalAnswer: "",
    refusal: undefined,
    moved: false,
    filesNote: "",
    fetched: undefined,
    streamAfter: undefined,
  };
}

export async function credential(ctx: TurnContext): Promise<string> {
  return ctx.hooks.keyProvider ? ctx.hooks.keyProvider() : ctx.request.key;
}

/** The language the turn's own lines are said in: the person's, else that of what they wrote. */
export function langOf(ctx: TurnContext): Lang {
  return ctx.request.lang ?? pickLang(ctx.request.text);
}

/** The message(s) the user quoted, marked as quotes, then what the user wrote (`activity.with_quote`). */
function withQuote(text: string, quote: string): string {
  return quote && text ? `${quote}\n\n${text}` : quote || text;
}

/**
 * What Claw is sent: the quoted messages, then what the user wrote (with the addresses behind its links), then where the
 * files they sent are. `text` stays the words alone: the session's title, the language of the answer.
 */
export function messageOf(ctx: TurnContext): string {
  const said = withQuote(ctx.request.sent || ctx.request.text, ctx.request.quote ?? "");
  const note = ctx.record.filesNote;
  return said && note ? `${said}\n\n${note}` : said || note;
}
