// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/approvals [on|off]`: whether the questions the person's own terminals ask (a coding agent started there wants to run a
 * command, change a file, start on a plan or have a question answered, and the connector's approval hooks put it here) come to
 * this chat. The setting is Claw's (`/v1/remote-agents/approvals`), on unless turned off; with no word it is only read.
 */
import { ClawError } from "../claw/errors.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";
import type { ClawRemoteAgentsPort } from "../ports/claw/remote-agents.js";
import type { CommandHandler, CommandRoute } from "../ports/routing.js";
import { textMessage } from "../ports/surface.js";
import { isTransport } from "./state.js";

export class TerminalApprovalsCommand implements CommandHandler {
  readonly name = "approvals";

  constructor(private readonly claw: Pick<ClawRemoteAgentsPort, "approvals" | "setApprovals">) {}

  async run(route: CommandRoute, args: string): Promise<boolean> {
    const words = terminalApprovalText.in(route.lang());
    const say = (text: string): Promise<void> => route.conversation.send(textMessage(text));
    const arg = args.trim().toLowerCase();
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
      if (!(error instanceof ClawError) && !isTransport(error)) throw error;
      await say(words.approvalsUnavailable);
    }
    return true;
  }
}
