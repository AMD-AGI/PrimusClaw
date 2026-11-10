// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How the end of a session (or of a turn, or a refused mode switch) is said: the reason in words, with the fix for an old connector. */
import { errorName } from "../errors.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { remoteLeads } from "../locales/remote-leads.js";
import { OLD_CONNECTOR, type Pair, ended } from "./connector/reasons.js";
import type { RemoteContext } from "./context.js";
import type { Lists } from "./lists.js";
import type { ChatState } from "./state.js";

/** What reads Claw for a person now: their key, or what a provider gives (an exchanged token). */
export type Provider = (() => Promise<string>) | undefined;

export async function credentialOf(key: string, provider: Provider): Promise<string> {
  return provider ? await provider() : key;
}

export class EndedWords {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly lists: Lists,
  ) {}

  /**
   * The version the machine's connector reports, when the reason is one an upgrade fixes and Claw says it; null otherwise (the
   * sentence then offers the upgrade, which cannot hurt).
   */
  async connectorVersion(
    key: string,
    provider: Provider,
    connectorId: string,
    reason: string | null,
  ): Promise<string | null> {
    if (!OLD_CONNECTOR.has((reason ?? "").trim()) || !connectorId) return null;
    try {
      const credential = await credentialOf(key, provider);
      if (!credential) return null;
      const found = (await this.lists.machines(credential)).connectors.find((c) => c.connectorId === connectorId);
      return found?.version ? found.version : null;
    } catch (error) {
      this.ctx.logger.info("the connector's version could not be read", { error: errorName(error) }); // (only a hint is lost)
      return null;
    }
  }

  /** `lead` with the reason after it, in the chat's language, the version read when an upgrade would fix it. */
  async said(
    chatKey: string,
    lead: Pair,
    key: string,
    provider: Provider,
    connectorId: string,
    reason: string,
  ): Promise<string> {
    const version = await this.connectorVersion(key, provider, connectorId, reason);
    return ended(lead, reason, this.state.lang(chatKey), version, this.ctx.setup.setup);
  }

  /**
   * The paragraph that says a session ended and why; `follow`: told while the chat was idle (its messages go to the assistant
   * again).
   */
  async sessionEnded(
    chatKey: string,
    key: string,
    provider: Provider,
    connectorId: string,
    reason: string,
    follow = false,
  ): Promise<string> {
    const lang = this.state.lang(chatKey);
    const words = remoteAgentText.in(lang);
    const head = await this.said(chatKey, remoteLeads.sessionEnded, key, provider, connectorId, reason);
    return head + (follow ? words.endedFollowTail : words.endedTail);
  }
}
