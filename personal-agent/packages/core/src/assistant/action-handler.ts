// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The buttons of the cards the assistant puts to the person, for the router (teams_agent/agent.py `_dispatch`: `_action_click` and
 * `_confirm_click`, after the person's key is read; a group chat answers neither). Run or Cancel under a command
 * (`assistant_action`), Allow or Deny on a write Claw holds (`assistant_confirm`).
 */
import type { ClickHandler, ClickRoute } from "../ports/routing.js";
import type { AssistantActions } from "./actions.js";

export class AssistantActionClicks implements ClickHandler {
  readonly verbs = ["assistant_action", "assistant_confirm"] as const;

  constructor(private readonly actions: Pick<AssistantActions, "actionClick" | "confirmClick">) {}

  async withCredential(click: ClickRoute, credential: string): Promise<void> {
    if (click.action.verb === "assistant_confirm") await this.actions.confirmClick(click);
    else await this.actions.actionClick(click, credential);
  }
}
