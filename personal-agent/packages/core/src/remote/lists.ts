// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the user has, read from Claw each time it is needed (their machines, their sessions, how to connect a machine), and the
 * views made of it: the agents card (`/agents`), the sessions card (`/agent sessions`), the pairing command. A list route answers
 * 404 only when remote agents are off on Claw (a missing id is 404 on the routes that take one), and that is said apart.
 */
import { ClawError } from "../claw/errors.js";
import type { RemoteConnector, RemoteSession } from "../claw/remote.js";
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { agentsText, pairText, sessionsText } from "../remote-view/index.js";
import { agentsMessage, sessionsMessage } from "./cards.js";
import { ConnectorSetup, pairCommand, setupFrom } from "./connector/setup.js";
import type { RemoteContext } from "./context.js";
import { type Connector, type Session, connectorFrom, sessionFrom } from "./model.js";

/** Claw answered 404 to a route that exists whenever remote agents are on: they are off on this PrimusClaw. */
export class RemoteOff extends Error {
  override readonly name = "RemoteOff";
}

/** What `/agents` shows: a card, or a text (rich: it holds commands to copy). */
export type AgentsAnswer =
  | { readonly kind: "card"; readonly message: import("../ports/surface.js").OutMessage }
  | { readonly kind: "rich"; readonly text: string }
  | { readonly kind: "text"; readonly text: string };

/** The machines and sessions as Claw listed them, read with the worker's defaults (`model.ts`). */
export interface Machines {
  readonly raw: readonly RemoteConnector[];
  readonly connectors: readonly Connector[];
}

export interface Sessions {
  readonly raw: readonly RemoteSession[];
  readonly sessions: readonly Session[];
}

/** 404 on a list route: remote agents are off. */
async function orOff<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ClawError && error.status === 404) throw new RemoteOff();
    throw error;
  }
}

export class Lists {
  constructor(private readonly ctx: RemoteContext) {}

  private now(): number {
    return this.ctx.clock.epochMs() / 1000;
  }

  async machines(key: string): Promise<Machines> {
    const raw = await orOff(() => this.ctx.claw.connectors(key));
    return { raw, connectors: raw.map(connectorFrom) };
  }

  async sessions(key: string): Promise<Sessions> {
    const raw = await orOff(() => this.ctx.claw.sessions(key));
    return { raw, sessions: raw.map(sessionFrom) };
  }

  /**
   * What connecting a machine takes here: Claw's own answer, else the same commands made from the address this worker reaches
   * Claw at (an older Claw has no such route).
   */
  async setup(key: string): Promise<ConnectorSetup> {
    let data: unknown = null;
    try {
      data = await this.ctx.claw.setup(key);
    } catch (error) {
      // (only Claw's own wording is lost: the same commands are made here)
      this.ctx.logger.info("Claw's connector setup could not be read; using this worker's address", {
        error: errorName(error),
      });
    }
    return new ConnectorSetup(setupFrom(data, this.ctx.clawBaseUrl));
  }

  /**
   * The pairing command for a new machine (`claw-connector pair`), or null when this Claw cannot give one: the caller then gives
   * the sign-in steps. The line a person pastes into a shell is rebuilt here, never taken as Claw wrote it.
   */
  async pairView(key: string, lang: Lang, lead = ""): Promise<string | null> {
    let got;
    try {
      got = await this.ctx.claw.pair(key);
    } catch (error) {
      if (error instanceof ClawError && (error.status === 404 || error.status === 503)) return null;
      throw error;
    }
    const command = pairCommand(got, this.ctx.clawBaseUrl);
    if (!command) {
      this.ctx.logger.warn("Claw's pairing answer was not usable (code or server of an unexpected shape)");
      return null;
    }
    return pairText(command, Math.trunc((got.expires_in || 600) / 60), lang, lead);
  }

  /** The line of a card with no machine to show. */
  noMachineLead(lang: Lang, lead: string): string {
    const line = remoteAgentText.in(lang).noMachineYet;
    return lead ? `${lead}\n\n${line}` : line;
  }

  /**
   * What `/agents` shows: the agents card (`machines` false: its sessions part alone), or a text when there is nothing to tap.
   * The sessions listed are remembered as the numbers of `/agent attach N`. `lead` is one line on top.
   */
  async agentsView(chatKey: string, key: string, lang: Lang, lead = "", machines = true): Promise<AgentsAnswer> {
    const listed = await this.machines(key);
    if (machines && listed.connectors.length === 0) {
      // Nothing to tap yet: the one command line that pairs a machine, when Claw gives one; else the exact sign-in steps.
      const paired = await this.pairView(key, lang, this.noMachineLead(lang, lead));
      if (paired) return { kind: "rich", text: paired };
      const steps = agentsText([], await this.setup(key), lang);
      return { kind: "rich", text: (lead ? `${lead}\n\n` : "") + steps };
    }
    const { sessions } = await this.sessions(key);
    const state = this.ctx.remoteState.attachedRemote(chatKey);
    const attached = state?.sessionId ?? null;
    const card = agentsMessage({
      connectors: listed.connectors,
      sessions,
      attached,
      now: this.now(),
      lead,
      machines,
      lang,
      names: new Map(
        [...this.ctx.sessionNames.remoteSessionNames(chatKey)].map(([sid, n]) => [
          sid,
          { title: n.title, ref: n.conversationRef },
        ]),
      ),
      own: this.ctx.sessionNames.remoteSessionAcps(chatKey),
      setup: this.ctx.setup,
    });
    if (!machines && card.listing.length === 0) {
      const { text, listing } = sessionsText(sessions, listed.connectors, attached, this.now(), lang);
      this.ctx.remoteState.setRemoteListing(chatKey, listing);
      return { kind: "text", text: (lead ? `${lead}\n\n` : "") + text };
    }
    this.ctx.remoteState.setRemoteListing(chatKey, card.listing);
    return { kind: "card", message: card.message };
  }

  /** Every session the user has, on every machine; its active ones are the numbers of `/agent attach N` from now on. */
  async sessionsView(
    chatKey: string,
    key: string,
    lang: Lang,
    lead = "",
  ): Promise<import("../ports/surface.js").OutMessage> {
    const listed = await this.machines(key);
    const { sessions } = await this.sessions(key);
    const state = this.ctx.remoteState.attachedRemote(chatKey);
    const card = sessionsMessage({
      connectors: listed.connectors,
      sessions,
      attached: state?.sessionId ?? null,
      now: this.now(),
      lang,
      lead,
      waiting: this.ctx.permissions.waitingRemoteSessions(chatKey),
      setup: listed.connectors.length === 0 ? await this.setup(key) : this.ctx.setup,
    });
    this.ctx.remoteState.setRemoteListing(chatKey, card.listing);
    return card.message;
  }
}
