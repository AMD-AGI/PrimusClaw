// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A press on an approval card, or Send on a question card (teams_agent/agent.py `_decide`). The card is not trusted: it is answered
 * only by the person it was pushed to (or, for an in-chat card, in their own session), and Claw is called with the clicker's own
 * key. In a session that acts as a person (a review for a colleague) the answer goes with that person's exchanged token only, and
 * when it cannot be had the card stays as it was. An approval is limited per person (a denial never is).
 */
import { ClawError } from "../claw/errors.js";
import { serviceRefusal } from "../claw/service-refusal.js";
import { errorName } from "../errors.js";
import { decisionText } from "../locales/approval-decisions.js";
import type { ClawSessionsPort } from "../ports/claw/index.js";
import type { Logger } from "../ports/logger.js";
import type { Approval, StorePort } from "../ports/store/index.js";
import type { TokenExchange } from "../plugins/token-exchange.js";
import { zoneOf } from "../proactive/quiet.js";
import { cpHead } from "../text/py-text.js";
import { viewMessage, type CardClick } from "./click.js";
import { QUESTION_TOOL, answersOf, cardQuestions } from "./questions.js";

export type DecisionStore = Pick<StorePort, "approvals" | "sessions" | "prefs" | "reviewDelegation" | "now">;

/** One approval's use of the person's allowance (guardrails): a refusal's text, or undefined when it may go on. */
export interface ApprovalAllowance {
  take(userId: string, ticket: object, details: ApprovalAuditIds): string | undefined;
  giveBack(userId: string, ticket: object): void;
}

/** What the audit records name an approval by: only what the store has from Claw, never a card's text. */
export interface ApprovalAuditIds {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly approvalId: string | null;
  readonly tool: string | null;
}

export interface ApprovalAudit extends ApprovalAuditIds {
  readonly userId: string;
  readonly decision: "approve" | "deny";
  readonly outcome: "success" | "failure" | "expired";
  readonly status: number | null;
}

export interface DecisionDeps {
  readonly store: DecisionStore;
  readonly claw: Pick<ClawSessionsPort, "decide" | "answer">;
  readonly exchange: TokenExchange;
  readonly allowance: ApprovalAllowance;
  readonly audit: (record: ApprovalAudit) => void;
  readonly logger: Logger;
  /** Offers the person the card that connects their identity (1:1 only). */
  readonly connectIdentity?: (click: CardClick) => Promise<void>;
  /** An approval of the running turn was denied: its answer comes with the Report a problem button. */
  readonly onDenied?: (userId: string, scope: string) => void;
}

/** What the press asks for, read from the card's data. */
interface Press {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly answering: boolean;
  readonly action: string;
  tool: string;
  readonly pending: Approval | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export class ApprovalDecisions {
  constructor(private readonly deps: DecisionDeps) {}

  /**
   * A press on an approval or question card in a group chat: answered ONLY by the person it was raised for (read from the stored
   * request, never the card); anyone else, linked or not, is refused before any key is read, and the card is put back for the
   * asker. `credential` reads the presser's linked key (null: none).
   */
  async inGroup(click: CardClick, credential: () => Promise<string | null>): Promise<void> {
    const press = this.read(click);
    const { pending } = press;
    const t = decisionText.in(click.lang());
    if (pending === null) {
      await click.settle(press.answering ? t.questionInactive : t.approvalInactive);
      return;
    }
    if (pending.userId !== click.sender.id) {
      const en = decisionText.in("en");
      await this.again(
        click,
        { ...press, tool: pending.tool },
        press.answering ? en.onlyAskerAnswers : en.onlyAskerDecides,
      );
      return;
    }
    if (this.deps.store.reviewDelegation.isActingSession(press.sessionId)) {
      await this.decide(click, null); // (answered with the exchanged token, never with a linked key)
      return;
    }
    const key = await credential();
    if (key === null) {
      await click.settle(t.notConnected);
      return;
    }
    await this.decide(click, key);
  }

  /** A press with the person's linked key (`key`; null when they have none). */
  async decide(click: CardClick, key: string | null): Promise<void> {
    const press = this.read(click);
    if (!(await this.valid(click, press))) return;
    const answers = press.answering ? answersOf(click.action.data) : undefined;
    if (answers && answers.answers.size === 0) {
      await this.again(click, press, decisionText.in("en").pressAgain);
      return;
    }
    const ids = this.auditIds(press);
    const ticket = {};
    const allow = press.action === "allow";
    if (allow) {
      const refused = this.deps.allowance.take(click.sender.id, ticket, ids);
      if (refused !== undefined) {
        await this.again(click, press, refused);
        return;
      }
    }
    const giveBack = (): void => {
      if (allow) this.deps.allowance.giveBack(click.sender.id, ticket);
    };
    const acting = this.deps.store.reviewDelegation.isActingSession(press.sessionId);
    const credential = acting ? await this.actingToken(click, press, giveBack) : key;
    if (credential === undefined) return;
    if (credential === null) {
      giveBack();
      await click.settle(decisionText.in(click.lang()).notConnected);
      return;
    }
    if (
      press.pending !== null &&
      !this.deps.store.approvals.closeApproval(press.sessionId, press.toolUseId, "sending")
    ) {
      giveBack(); // (a double tap loses here)
      await click.settle(decisionText.in(click.lang()).approvalAnswered);
      return;
    }
    await this.send(click, press, { credential, acting, answers, ids, giveBack });
  }

  private read(click: CardClick): Press {
    const data = click.action.data;
    const answering = data["primusclaw"] === "answer";
    const sessionId = str(data["session_id"]);
    const toolUseId = str(data["tool_use_id"]);
    return {
      sessionId,
      toolUseId,
      answering,
      action: answering ? "answer" : str(data["action"]),
      tool: answering ? QUESTION_TOOL : str(data["tool"]) || "the requested action",
      pending: this.deps.store.approvals.getApproval(sessionId, toolUseId),
    };
  }

  /** The press may be answered: the person's own, still pending and in time. Otherwise the card is settled and false. */
  private async valid(click: CardClick, press: Press): Promise<boolean> {
    const { store } = this.deps;
    const t = decisionText.in(click.lang());
    const { pending } = press;
    const foreign =
      !["allow", "deny", "answer"].includes(press.action) ||
      (pending !== null && pending.userId !== click.sender.id) ||
      (pending === null && press.sessionId !== store.sessions.getSession(click.sender.id, click.scope)) ||
      (press.answering && pending !== null && pending.tool !== QUESTION_TOOL);
    if (foreign) {
      await click.settle(press.answering ? t.questionInactive : t.approvalInactive);
      return false;
    }
    if (pending === null) return true;
    press.tool = pending.tool;
    if (pending.state !== "pending") {
      await click.settle(press.answering ? t.questionAnswered : t.approvalAnswered);
      return false;
    }
    if (store.now() >= pending.expiresAt) {
      store.approvals.closeApproval(press.sessionId, press.toolUseId, "expired");
      await this.showExpired(click, press.tool);
      return false;
    }
    return true;
  }

  private auditIds(press: Press): ApprovalAuditIds {
    const { pending } = press;
    return {
      sessionId: press.sessionId,
      toolUseId: press.toolUseId,
      approvalId: pending !== null ? press.toolUseId || null : null,
      tool: pending !== null ? pending.tool : null,
    };
  }

  /**
   * The exchanged token of the clicker for a session that acts as a person; undefined when it cannot be had (the card was put
   * back and the allowance given back).
   */
  private async actingToken(click: CardClick, press: Press, giveBack: () => void): Promise<string | undefined> {
    const { exchange, logger, connectIdentity } = this.deps;
    const token = exchange.enabled ? await exchange.tokenFor(click.sender.id) : undefined;
    if (token?.ok) return token.value;
    giveBack();
    const en = decisionText.in("en");
    if (token === undefined || token.error.kind === "not_bound" || token.error.kind === "exchange_unavailable") {
      await this.again(click, press, en.notBound);
      if (!click.scope && exchange.enabled && connectIdentity) {
        try {
          await connectIdentity(click);
        } catch (error) {
          logger.warn("the card that connects an approver could not be sent", { error: errorName(error) });
        }
      }
      return undefined;
    }
    logger.warn("the token to answer an approval could not be exchanged", { reason: token.error.reason });
    await this.again(click, press, en.exchangeFailed);
    return undefined;
  }

  private async send(
    click: CardClick,
    press: Press,
    call: {
      credential: string;
      acting: boolean;
      answers: ReturnType<typeof answersOf> | undefined;
      ids: ApprovalAuditIds;
      giveBack: () => void;
    },
  ): Promise<void> {
    const { claw, store } = this.deps;
    const options = call.acting ? { acting: true } : {};
    try {
      if (call.answers) {
        const answers = Object.fromEntries(call.answers.answers);
        await claw.answer(call.credential, press.sessionId, press.toolUseId, answers, call.answers.skipped, options);
      } else {
        await claw.decide(call.credential, press.sessionId, press.toolUseId, press.action, options);
      }
    } catch (error) {
      call.giveBack();
      await this.failed(click, press, call, error);
      return;
    }
    this.record(click, press, call.ids, "success", null);
    if (press.pending !== null) {
      store.approvals.closeApproval(press.sessionId, press.toolUseId, "decided", { onlyIfPending: false });
    }
    if (press.action === "deny") this.deps.onDenied?.(click.sender.id, click.scope);
    await this.settled(click, press, call.answers);
  }

  private async failed(
    click: CardClick,
    press: Press,
    call: { acting: boolean; ids: ApprovalAuditIds },
    error: unknown,
  ): Promise<void> {
    const { store } = this.deps;
    const en = decisionText.in("en");
    const status = error instanceof ClawError ? error.status : null;
    if (status === null && !isTransport(error)) throw error;
    const stale = status === 404 || status === 409 || status === 410;
    this.record(click, press, call.ids, stale ? "expired" : "failure", status);
    if (press.pending !== null) {
      store.approvals.closeApproval(press.sessionId, press.toolUseId, stale ? "expired" : "pending", {
        onlyIfPending: false,
      });
    }
    if (stale) await this.showExpired(click, press.tool);
    else if (status === null) await this.again(click, press, en.unreachable);
    else if (call.acting && status === 403 && error instanceof ClawError) {
      await this.again(click, press, serviceRefusal(error, en.notSent));
    } else await this.again(click, press, en.refused({ answering: press.answering, status }));
  }

  private record(
    click: CardClick,
    press: Press,
    ids: ApprovalAuditIds,
    outcome: ApprovalAudit["outcome"],
    status: number | null,
  ) {
    if (press.answering) return;
    this.deps.audit({
      ...ids,
      userId: click.sender.id,
      decision: press.action === "allow" ? "approve" : "deny",
      outcome,
      status,
    });
  }

  private async settled(
    click: CardClick,
    press: Press,
    answers: ReturnType<typeof answersOf> | undefined,
  ): Promise<void> {
    const { store } = this.deps;
    const zone = zoneOf(store.prefs.getPrefs(click.sender.id));
    const en = decisionText.in("en");
    if (answers) {
      const view = {
        name: "questionAnswered" as const,
        model: { answers: [...answers.answers], when: store.now(), zone },
      };
      await click.settle(viewMessage(view), { fallback: en.answered });
      return;
    }
    const allow = press.action === "allow";
    const view = {
      name: "approvalDecided" as const,
      model: { tool: press.tool, action: press.action, when: store.now(), zone },
    };
    await click.settle(viewMessage(view), { fallback: en.decided({ allow, tool: cpHead(press.tool, 100) }) });
  }

  /** It did not go through: the card comes back as it was, to be pressed again. */
  private async again(click: CardClick, press: Press, text: string): Promise<void> {
    if (press.answering) {
      const model = {
        questions: cardQuestions(click.action.data["questions"]),
        sessionId: press.sessionId,
        toolUseId: press.toolUseId,
        group: Boolean(click.scope),
        ownerName: "",
        note: text,
      };
      await click.settle(viewMessage({ name: "question", model }), { fallback: text });
      return;
    }
    const model = { text, tool: press.tool, sessionId: press.sessionId, toolUseId: press.toolUseId };
    await click.settle(viewMessage({ name: "approvalAgain", model }), { fallback: text });
  }

  private async showExpired(click: CardClick, tool: string): Promise<void> {
    const en = decisionText.in("en");
    const fallback = tool === QUESTION_TOOL ? en.questionExpired : en.approvalExpired;
    await click.settle(viewMessage({ name: "approvalExpired", model: { tool } }), { fallback });
  }
}

/** No answer at all from Claw (the decision may not have arrived), as against a bug. */
function isTransport(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ClawUnreachable" || error.name === "TypeError" || error.name === "AbortError")
  );
}
