// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The buttons of work item cards and of the board, for the router (teams_agent/agent.py `_dispatch`, `Assistant.on_click`). A
 * person with no linked key (their review runs on someone else's) presses with their exchanged token instead.
 */
import type { Logger } from "../ports/logger.js";
import type { ClickHandler, ClickRoute } from "../ports/routing.js";
import type { TokenExchange } from "../plugins/token-exchange.js";
import { finish } from "./finish.js";
import { boardText } from "../locales/assistant-board.js";
import type { WatchClicks } from "./watch-clicks.js";
import type { WorkClicks } from "./work-clicks.js";

export class WorkCardClicks implements ClickHandler {
  readonly verbs = ["work"] as const;

  constructor(
    private readonly work: WorkClicks,
    private readonly watch: WatchClicks,
    private readonly exchange: TokenExchange,
    /** Whether the person has a linked key. */
    private readonly linked: (userId: string) => boolean,
    private readonly logger: Logger,
  ) {}

  async beforeCredential(click: ClickRoute): Promise<boolean> {
    if (!this.exchange.enabled || this.linked(click.sender.id)) return false;
    const token = await this.exchange.tokenFor(click.sender.id);
    if (!token.ok) {
      this.logger.info("a work card of a person without a key could not be answered", { kind: token.error.kind });
      return false;
    }
    await this.withCredential(click, token.value);
    return true;
  }

  async withCredential(click: ClickRoute, credential: string): Promise<void> {
    const op = click.action.data["op"];
    switch (op) {
      case "accept":
      case "stop":
        return this.work.acceptOrStop(click, credential, op);
      case "retry":
        return this.work.retry(click, credential);
      case "accept_all":
        return this.work.acceptAll(click, credential);
      case "watch":
        return this.watch.watch(click, credential);
      case "unwatch":
        return this.watch.unwatch(click, credential);
      default:
        return finish(click, boardText.in("en").cardGone);
    }
  }
}
