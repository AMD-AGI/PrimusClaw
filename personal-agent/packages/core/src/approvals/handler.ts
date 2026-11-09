// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The buttons of approval and question cards, for the router (teams_agent/agent.py `_dispatch` and `_route_group` for these cards).
 * A card of a session that acts as a person is answered before any key is read: it is never answered with one.
 */
import type { ClickHandler, ClickRoute } from "../ports/routing.js";
import type { ApprovalDecisions } from "./decide.js";

export class ApprovalClicks implements ClickHandler {
  readonly verbs = ["decision", "answer"] as const;

  constructor(
    private readonly decisions: ApprovalDecisions,
    /** Whether the session acts as a person (a review for a colleague): the store says so, never the card. */
    private readonly actsAsPerson: (sessionId: string) => boolean,
    /** The presser's linked key, read only when needed (null: none). */
    private readonly linkedKey: (userId: string) => Promise<string | null>,
  ) {}

  async beforeCredential(click: ClickRoute): Promise<boolean> {
    const sessionId = click.action.data["session_id"];
    if (!this.actsAsPerson(typeof sessionId === "string" ? sessionId : "")) return false;
    await this.decisions.decide(click, null);
    return true;
  }

  async withCredential(click: ClickRoute, credential: string): Promise<void> {
    await this.decisions.decide(click, credential);
  }

  async inGroup(click: ClickRoute): Promise<boolean> {
    await this.decisions.inGroup(click, () => this.linkedKey(click.sender.id));
    return true;
  }
}
