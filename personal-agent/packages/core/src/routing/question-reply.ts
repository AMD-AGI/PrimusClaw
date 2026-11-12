// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message typed while the agent waits on a question card is the answer to that question. Without this it went to Claw as a
 * new message, which Claw queues behind the turn that asked: it ran only once the question had timed out (ten minutes), and
 * the agent, never answered, asked again. The card's own answer path (`approvals/decide.ts`) takes free text; this sends the
 * typed words the same way and settles the card where it is.
 */
import { cardQuestions, typedAnswers, type CardQuestion } from "../approvals/questions.js";
import { viewMessage } from "../approvals/click.js";
import { errorName } from "../errors.js";
import { answerLang } from "../language/detect.js";
import { approvalText } from "../locales/approval.js";
import { zoneOf } from "../proactive/quiet.js";
import type { PendingQuestion } from "../ports/store/index.js";
import { pyStrip } from "../text/py-text.js";
import { ClawError } from "../claw/errors.js";
import { isClawOrNetwork, statusOrKind } from "../turn/engine/claw-errors.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";

/**
 * A question with less than this left of its wait is not answered from a typed message: Brain may already have stopped
 * waiting (the card's time is counted from when the worker saw the question, a little after Brain's), and an answer nobody
 * waits for is dropped. The message then goes on as a new one, as before.
 */
export const TYPED_ANSWER_MARGIN_SECONDS = 15;

/** A typed message that may answer the person's waiting question. */
export interface TypedReply {
  readonly chat: Chat;
  readonly text: string;
  /** The Claw credential of the person, read when there is a question to answer. */
  readonly credential: () => Promise<string>;
}

/**
 * Answers the question card that waits in the chat's session with `reply.text`: true when it did (the card now says
 * "Answered: ...", and the message must not go on as a new one); false when there was nothing to answer, or it could not be
 * answered (the message then goes on as before). Only the person the card was raised for answers it: their own session in
 * this chat, their own record.
 */
export async function answerWaitingQuestion(ctx: RouterContext, reply: TypedReply): Promise<boolean> {
  const { store, claw, logger } = ctx.deps;
  const { chat } = reply;
  const waiting = waitingQuestion(ctx, reply);
  if (waiting === undefined) return false;
  const { pending, questions } = waiting;
  const { sessionId, toolUseId } = pending;
  const key = await stillAsked(ctx, reply, pending);
  if (key === undefined) return false;
  if (!store.approvals.closeApproval(sessionId, toolUseId, "sending")) return false; // (the card was pressed meanwhile)
  const answers = typedAnswers(questions, reply.text);
  try {
    await claw.sessions.answer(key, sessionId, toolUseId, Object.fromEntries(answers.answers), answers.skipped);
  } catch (error) {
    if (!isClawOrNetwork(error)) throw error;
    const stale = error instanceof ClawError && [404, 409, 410].includes(error.status);
    store.approvals.closeApproval(sessionId, toolUseId, stale ? "expired" : "pending", { onlyIfPending: false });
    logger.warn("a typed answer to a question card was not taken; the message goes on as a new one", {
      error: statusOrKind(error),
    });
    return false;
  }
  store.approvals.closeApproval(sessionId, toolUseId, "decided", { onlyIfPending: false });
  logger.info("a typed message answered the question card waiting in the chat", {
    chat: chat.scope ? "group" : "1:1",
    questions: questions.length,
    card: pending.cardId ? "edited" : "not editable",
  });
  // The card speaks the chat's language (the person's chosen or learnt language, else the client's locale, as `chat.lang()`),
  // and without either the question's: never the reply's alone, since "1" or "a" typed in a Chinese chat is no English.
  const lang = answerLang(store.prefs.getPrefs(chat.sender.id).lang, chat.locale, questions[0]?.question, reply.text);
  await settleCard(ctx, chat, pending.cardId, [...answers.answers], lang);
  return true;
}

/** The person's question card waiting in the chat's session, in time, with the questions it asks; undefined when none. */
function waitingQuestion(
  ctx: RouterContext,
  reply: TypedReply,
): { readonly pending: PendingQuestion; readonly questions: CardQuestion[] } | undefined {
  const { store } = ctx.deps;
  const { chat } = reply;
  if (!pyStrip(reply.text)) return undefined;
  const sessionId = store.sessions.getSession(chat.sender.id, chat.scope);
  if (sessionId === null || store.reviewDelegation.isActingSession(sessionId)) return undefined;
  const pending = store.approvals.pendingQuestion(sessionId, chat.sender.id);
  if (pending === null || pending.expiresAt - store.now() < TYPED_ANSWER_MARGIN_SECONDS) return undefined;
  const questions = cardQuestions(pending.questions);
  return questions.length === 0 ? undefined : { pending, questions };
}

/**
 * The person's key, when Claw is still running the turn that asked; undefined when it is not (the record is closed: nothing
 * waits for an answer, which Claw would take and drop) or that could not be read.
 */
async function stillAsked(
  ctx: RouterContext,
  reply: TypedReply,
  pending: PendingQuestion,
): Promise<string | undefined> {
  const { store, claw, logger } = ctx.deps;
  try {
    const key = await reply.credential();
    if ((await claw.sessions.turn(key, pending.sessionId)).running) return key;
    store.approvals.closeApproval(pending.sessionId, pending.toolUseId, "expired");
    return undefined;
  } catch (error) {
    if (!isClawOrNetwork(error)) throw error;
    logger.warn("a typed answer to a question card was not sent: the session's turn could not be read", {
      error: statusOrKind(error),
    });
    return undefined;
  }
}

/** The card says what it was answered with, where it is; a card the chat never gave the id of gets the same words below it. */
async function settleCard(
  ctx: RouterContext,
  chat: Chat,
  cardId: string,
  answers: readonly (readonly [string, string])[],
  lang: "zh" | "en",
): Promise<void> {
  const { store, logger } = ctx.deps;
  const zone = zoneOf(store.prefs.getPrefs(chat.sender.id));
  const answer = [...new Set(answers.map(([, a]) => a))].join(" / ");
  const words = approvalText.in(lang).questionReplied({ answer });
  try {
    if (cardId) {
      const view = { name: "questionAnswered" as const, model: { answers, when: store.now(), zone, replied: lang } };
      await chat.conversation.update(cardId, viewMessage(view, words));
    } else {
      await chat.say(words);
    }
  } catch (error) {
    // (the answer is in: a card left as it was only looks unanswered, and pressing it is answered as already answered)
    logger.warn("the question card could not be marked answered", { error: errorName(error) });
  }
}
