// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/approvals [on|off]`: whether the questions the person's own terminals ask (a coding agent started there wants to run a
 * command, change a file, start on a plan or have a question answered, and the connector's approval hooks put it here), their
 * waits and the turns that ended while nobody was there come to this chat. The setting is Claw's (`/v1/remote-agents/approvals`),
 * on unless turned off; with no word it is only read. `/approvals mute #<item>` and `unmute #<item>` do the same for one
 * conversation, named by the work item its messages start with (`PUT /v1/remote-agents/approvals/mutes`).
 */
import { ClawAnswerInvalid, ClawError } from "../claw/errors.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";
import type { ClawRemoteAgentsPort } from "../ports/claw/remote-agents.js";
import type { CommandHandler, CommandRoute } from "../ports/routing.js";
import { textMessage } from "../ports/surface.js";
import { isTransport } from "./state.js";

export class TerminalApprovalsCommand implements CommandHandler {
  readonly name = "approvals";

  constructor(private readonly claw: Pick<ClawRemoteAgentsPort, "approvals" | "setApprovals" | "muteTerminal">) {}

  async run(route: CommandRoute, args: string): Promise<boolean> {
    const words = terminalApprovalText.in(route.lang());
    const say = (text: string): Promise<void> => route.conversation.send(textMessage(text));
    const arg = args.trim().toLowerCase();
    const one = /^(mute|unmute)\s+#?(\d{1,9})$/.exec(arg);
    if (one) return this.mute(route, one[1] === "mute", Number(one[2]));
    if (arg !== "" && arg !== "on" && arg !== "off") {
      await say(words.approvalsUsage);
      return true;
    }
    try {
      if (arg === "") await say((await this.claw.approvals(route.credential)) ? words.approvalsOn : words.approvalsOff);
      else {
        const enabled = await this.claw.setApprovals(route.credential, arg === "on");
        await say(enabled ? words.approvalsTurnedOn : words.approvalsTurnedOff);
      }
    } catch (error) {
      if (!(error instanceof ClawError) && !(error instanceof ClawAnswerInvalid) && !isTransport(error)) throw error;
      await say(words.approvalsUnavailable);
    }
    return true;
  }

  private async mute(route: CommandRoute, muted: boolean, item: number): Promise<boolean> {
    const words = terminalApprovalText.in(route.lang());
    const say = (text: string): Promise<void> => route.conversation.send(textMessage(text));
    const n = String(item);
    try {
      const out = await this.claw.muteTerminal(route.credential, item, muted);
      const where = [out.machine, out.title].filter(Boolean).join(" · ");
      await say(out.muted ? words.muted({ item: n, where }) : words.unmuted({ item: n, where }));
    } catch (error) {
      if (error instanceof ClawError && error.status === 404) await say(words.muteNotFound({ item: n }));
      else if (error instanceof ClawError && error.code === "not_a_terminal_item")
        await say(words.muteNotTerminal({ item: n }));
      else if (error instanceof ClawError || error instanceof ClawAnswerInvalid || isTransport(error))
        await say(words.approvalsUnavailable);
      else throw error;
    }
    return true;
  }
}
