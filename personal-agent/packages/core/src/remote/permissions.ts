// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A remote agent's permission requests: one card per request, and the click on one of its options. A card is not trusted: the
 * request is looked up in the store (its owner, the options the agent offered, when it runs out) and a click is refused unless it
 * is the owner's, names one of those options and comes in time. One click wins a double tap; the option id goes to Claw as the
 * agent gave it. An approval is limited per person (a rejection never is), and "always allow" counts as a mode that does not ask.
 */
import { ClawError } from "../claw/errors.js";
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { remoteText } from "../locales/remote.js";
import type { RemotePermission } from "../ports/store/remote.js";
import { type Conversation, type OutMessage, textMessage } from "../ports/surface.js";
import { PERMISSION_DEFAULT_SECONDS } from "./limits.js";
import { type PermissionOption, decidedVerdict, parseOptions } from "./options.js";
import { neutral } from "../text/neutral.js";
import { noteCard, reopenedCard } from "./views.js";
import { isGroupKey, personOf } from "./chat-key.js";
import type { GuardedOperation, RemoteContext } from "./context.js";
import { textOf } from "./fields.js";
import { saidIn } from "./refusals.js";
import type { StatusBoard } from "./board.js";
import { type ChatState, isTransport } from "./state.js";
import { own } from "../own.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";
import { isTerminalPermission, mayChoose } from "./terminal-asks.js";

/** How a click ends: the clicked card replaced by `card` (a note when it is text), and the outcome said (W4's `ClickRoute.settle`). */
export type Settle = (
  card: OutMessage | string,
  options?: { readonly fallback?: string; readonly announce?: boolean },
) => Promise<boolean>;

/** A click on an option of a permission card. */
export interface Decision {
  /** Who clicked (their 1:1 chat key). */
  readonly person: string;
  readonly key: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly settle: Settle;
}

/** The longest an agent may give a request (an hour); a request that says none lives PERMISSION_DEFAULT_SECONDS. */
const TIMEOUT_MAX_MS = 3_600_000;

function secondsOf(timeout: unknown): number {
  return typeof timeout === "number" && timeout > 0 && timeout <= TIMEOUT_MAX_MS
    ? timeout / 1000
    : PERMISSION_DEFAULT_SECONDS;
}

/** The one line an answered approval comes to ("已允许一次：Bash", "Allowed once: Bash."). */
export function decidedLine(option: PermissionOption, tool: string, lang: Lang): string {
  const verdict = decidedVerdict(option, lang);
  const shown = neutral(tool, 100);
  return lang === "zh" ? `${verdict}：${shown}` : `${verdict}: ${shown}.`;
}

/** The origins of a question a terminal asks: as the connector marks it, and as Claw's push names it. */
const TERMINAL_ORIGINS: ReadonlySet<string> = new Set(["terminal_hook", "terminal"]);

export class Permissions {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
  ) {}

  /**
   * One card per request. The row is written BEFORE the card is shown, so the owner and the options are known when it is clicked;
   * a request the connector sends again after a reconnect finds its row and is not shown twice.
   */
  async show(
    chatKey: string,
    sessionId: string,
    request: Readonly<Record<string, unknown>>,
    to: Conversation,
  ): Promise<void> {
    const state = this.state.attached(chatKey);
    const lang = this.state.lang(chatKey);
    const actionId = textOf(request["actionId"]);
    // A question a terminal asks reaches the owner as its own card (Claw's push, which shows its content): a chat attached to the
    // session that carries it draws nothing, so the request is never shown here with every option and none of the content.
    // (the connector marks it `terminal_hook`; `terminal` is how Claw's push names the same origin: either is never drawn here)
    if (TERMINAL_ORIGINS.has(textOf(request["origin"]))) return;
    const options = parseOptions(request["options"]);
    if (!actionId || options.length === 0) {
      await to.send(textMessage(saidIn(lang, "noAnswerableOption")));
      return;
    }
    const expiresAt = this.ctx.clock.epochMs() / 1000 + secondsOf(request["timeout_ms"]);
    const words = remoteText.in(lang);
    const tool = textOf(request["tool"]) || words.anAction;
    if (!this.ctx.permissions.saveRemotePermission({ userId: chatKey, sessionId, actionId, tool, options, expiresAt }))
      return;
    const who = state ? words.agentOnHost({ agent: state.agentLabel, host: state.host }) : words.theAgent;
    const forget = (): void => {
      this.ctx.permissions.forgetRemotePermission(sessionId, actionId); // the connector's next resend must be able to show it
    };
    if (state?.window === "card" && state.sessionId === sessionId && !isGroupKey(chatKey)) {
      // The session card is the window: the request shows there as buttons, the card posted again at the bottom
      await this.board.refreshWindow(chatKey, to).catch((error: unknown) => {
        forget();
        throw error;
      });
      return;
    }
    // A group binding's request goes to the binder's 1:1 chat: the group sees only that it waits, never what it asks for.
    const personal = isGroupKey(chatKey) ? this.ctx.references.getReference(personOf(chatKey)) : null;
    try {
      // (a card that cannot be built, from a request no card can show, is forgotten as one that could not be sent)
      const card = this.ctx.views.permission({
        request,
        options,
        sessionId,
        who,
        expiresAt,
        zone: this.state.zone(chatKey),
        lang,
      });
      await (personal ? this.ctx.conversationFor(personal) : to).send(card);
    } catch (error) {
      forget();
      throw error;
    }
    if (personal) await to.send(textMessage(remoteAgentText.in(lang).approvalInPersonal({ who })));
  }

  /** The card again with its buttons and `text` on it: the decision did not go through. */
  private reopened(perm: RemotePermission, text: string, lang: Lang): OutMessage {
    const title = remoteText.in(lang).approvalNeeded({ tool: neutral(perm.tool, 100) });
    // (a terminal's question comes back without its content: only the options that turn it down, never an approval unseen)
    const options = parseOptions(perm.options).filter(
      (o) => !isTerminalPermission(perm) || o.kind.startsWith("reject"),
    );
    return reopenedCard(this.ctx.views.optionButtons(options, perm.sessionId, perm.actionId, lang), title, text);
  }

  /** A click on an option of a permission card (see the module). */
  async decide(click: Decision): Promise<void> {
    const lang = this.state.lang(click.person);
    const [sessionId, actionId, optionId] = ["session_id", "action_id", "option_id"].map((k) =>
      textOf(own(click.data, k)),
    );
    const perm = this.ctx.settings.enabled
      ? this.ctx.permissions.getRemotePermission(sessionId ?? "", actionId ?? "")
      : null;
    const option = perm ? parseOptions(perm.options).find((o) => o.optionId === optionId) : undefined;
    // (a group binding's request is answered from the binder's 1:1 chat, where its card is shown; nothing else crosses chats)
    const owner =
      perm !== null &&
      (perm.userId === click.person || (isGroupKey(perm.userId) && personOf(perm.userId) === click.person));
    // (a terminal's question its card did not show whole is never approved from here, whatever the button says)
    if (perm === null || !owner || option === undefined || !mayChoose(perm, option)) {
      await click.settle(saidIn(lang, "approvalInactive"));
      return;
    }
    if (perm.state === "terminal") {
      await click.settle(terminalApprovalText.in(lang).answeredInTerminalLine);
      return;
    }
    if (perm.state !== "pending") {
      await click.settle(saidIn(lang, "approvalAnswered"));
      return;
    }
    if (this.ctx.clock.epochMs() / 1000 >= perm.expiresAt) {
      await this.ranOut(click, perm, lang);
      return;
    }
    await this.answer(click, perm, option, lang);
  }

  /** Past its time a request is refused, whatever the button says. */
  private async ranOut(click: Decision, perm: RemotePermission, lang: Lang): Promise<void> {
    this.ctx.permissions.closeRemotePermission(perm.sessionId, perm.actionId, "expired");
    const words = remoteAgentText.in(lang);
    const card = noteCard(words.ranOutRefused({ tool: neutral(perm.tool, 100) }), words.expiredTitle);
    await click.settle(card, { fallback: saidIn(lang, "approvalRanOut") });
  }

  private async answer(click: Decision, perm: RemotePermission, option: PermissionOption, lang: Lang): Promise<void> {
    const decision = option.kind.startsWith("reject") ? "deny" : "approve";
    // "Always allow" is a standing grant for the rest of the session, as wide as a mode that does not ask
    const operation: GuardedOperation = option.kind === "allow_always" ? "remote_agent" : "approval";
    const correlation = this.ctx.digestHex("sha256", `${perm.sessionId}\x1f${perm.actionId}`).slice(0, 32);
    const audited = {
      operation,
      aad_object_id: click.person,
      session_id: perm.sessionId || null,
      approval_id: perm.actionId || null,
      decision,
      correlation_id: correlation,
    };
    const ticket = {}; // (names this approval's count, for giveBack)
    const counted = decision === "approve";
    if (counted) {
      const refused = this.ctx.guard.take(click.person, operation, ticket, {
        session_id: audited.session_id,
        approval_id: audited.approval_id,
        correlation_id: correlation,
      });
      if (refused) {
        await click.settle(this.reopened(perm, refused.text(), lang), { fallback: refused.text() });
        return;
      }
    }
    const giveBack = (): void => {
      if (counted) this.ctx.guard.giveBack(click.person, operation, ticket); // (not given: it does not use up the allowance)
    };
    if (!this.ctx.permissions.closeRemotePermission(perm.sessionId, perm.actionId, "sending")) {
      giveBack(); // a double tap loses here
      await click.settle(saidIn(lang, "approvalAnswered"));
      return;
    }
    if (await this.send(click, perm, option, lang, { audited, giveBack })) {
      this.ctx.audit("approval_answered", { ...audited, outcome: "success" });
      this.ctx.permissions.closeRemotePermission(perm.sessionId, perm.actionId, "decided", { onlyIfPending: false });
      const card = this.ctx.views.decided(option, this.ctx.clock.epochMs() / 1000, this.state.zone(click.person), lang);
      await click.settle(card, { fallback: decidedLine(option, perm.tool, lang) });
    }
  }

  /** The decision to Claw; false (and the click answered) when it did not go through. */
  private async send(
    click: Decision,
    perm: RemotePermission,
    option: PermissionOption,
    lang: Lang,
    how: { readonly audited: Readonly<Record<string, string | null>>; readonly giveBack: () => void },
  ): Promise<boolean> {
    const again = async (text: string): Promise<void> => {
      // the decision did not go through: the card comes back with its buttons, unless the request was ended meanwhile (the
      // terminal answered it while this click was on its way): then it says so instead
      if (
        !this.ctx.permissions.closeRemotePermission(perm.sessionId, perm.actionId, "pending", {
          onlyIfState: "sending",
        })
      ) {
        const now = this.ctx.permissions.getRemotePermission(perm.sessionId, perm.actionId);
        await click.settle(
          now?.state === "terminal"
            ? terminalApprovalText.in(lang).answeredInTerminalLine
            : saidIn(lang, "approvalAnswered"),
        );
        return;
      }
      await click.settle(this.reopened(perm, text, lang), { fallback: text });
    };
    try {
      await this.ctx.claw.decide(click.key, perm.sessionId, perm.actionId, option.optionId);
      return true;
    } catch (error) {
      if (!(error instanceof ClawError) && !isTransport(error)) throw error;
      how.giveBack();
      if (!(error instanceof ClawError)) {
        this.ctx.audit("approval_answered", { ...how.audited, outcome: "failure" });
        await again(saidIn(lang, "unreachable") + remoteAgentText.in(lang).pressAgain);
        return false;
      }
      const gone = error.status === 404 || error.status === 409; // the request is gone, answered elsewhere, or its session ended
      this.ctx.audit("approval_answered", {
        ...how.audited,
        outcome: gone ? "expired" : "failure",
        status: error.status || null,
      });
      if (!gone) {
        await again(remoteAgentText.in(lang).decisionNotAccepted({ status: error.status }));
        return false;
      }
      this.ctx.permissions.closeRemotePermission(perm.sessionId, perm.actionId, "expired", { onlyIfPending: false });
      // (a question a terminal asks that Claw says is answered: the terminal answered first)
      const terminalFirst = perm.ask?.["origin"] === "terminal" && error.status === 409;
      await click.settle(
        terminalFirst ? terminalApprovalText.in(lang).answeredInTerminalLine : saidIn(lang, "approvalAnswered"),
      );
      return false;
    }
  }
}
