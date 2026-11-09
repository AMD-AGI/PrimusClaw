// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Taps about a machine rather than a session: hiding conversations from the person's lists (nothing on the machine changes) and
 * showing them again, and the disconnect card. What a card names is read again from the person's own list; Claw answers 404 for
 * anyone else's.
 */
import { ClawError } from "../claw/errors.js";
import type { Lang } from "../locales/lang.js";
import { remoteOffText, remoteText } from "../locales/remote.js";
import { disconnectTitle, disconnectedText, hiddenOf, hiddenView, resumableOf } from "../remote-view/index.js";
import { neutral } from "../text/neutral.js";
import { viewMessage } from "./cards.js";
import type { Click, SessionClicks } from "./clicks.js";
import type { CommandParts } from "./commands.js";
import { textOf } from "./fields.js";
import { RemoteOff } from "./lists.js";
import { type Connector, connectorById } from "./model.js";
import { failureText, saidIn } from "./refusals.js";
import { isTransport } from "./state.js";
import { disconnectAgainCard } from "./views.js";

export class MachineClicks {
  constructor(
    private readonly p: CommandParts,
    private readonly c: SessionClicks,
  ) {}

  /** The person's connector the tapped button names, as Claw lists it now; null (said) when it is not theirs any more. */
  private async ownConnector(click: Click, includeHidden = false): Promise<Connector | null> {
    const { connectors } = await this.p.lists.machines(click.key, includeHidden);
    const found = connectorById(connectors, textOf(click.data["connector_id"]));
    if (found === undefined) await this.c.home(click, saidIn(this.c.lang(click), "agentGone"));
    return found ?? null;
  }

  /** Hide one conversation (`ref`), or every one no process runs of one agent (`all: idle`), from the list. */
  async hide(click: Click): Promise<void> {
    const connector = await this.ownConnector(click);
    if (connector === null) return;
    const lang = this.c.lang(click);
    let entries;
    if (click.data["all"] === "idle") {
      const agent = connector.agents.find((a) => a.agentId === textOf(click.data["agent_id"]));
      entries = (agent ? resumableOf(agent) : []).filter((e) => e.state === "idle");
    } else {
      const ref = textOf(click.data["ref"]);
      entries = connector.agents.flatMap((a) => resumableOf(a).filter((e) => e.ref === ref)).slice(0, 1);
    }
    if (entries.length === 0) return this.c.home(click, saidIn(lang, "conversationGone"));
    const out = await this.p.ctx.claw.hide(
      click.key,
      connector.connectorId,
      entries.map((e) => e.ref),
      true,
    );
    const titles = new Map(entries.map((e) => [e.ref, e.title]));
    const words = remoteText.in(lang);
    const lines = [words.hidN({ n: out.changed.length })];
    for (const refused of out.refused) {
      if (refused.reason === "live")
        lines.push(words.hideLive({ title: neutral(titles.get(refused.ref) ?? "", 60) || "?" }));
    }
    await this.c.home(click, lines.join(" "));
  }

  /** The conversations hidden on that machine, each with Unhide. */
  async hidden(click: Click): Promise<void> {
    const connector = await this.ownConnector(click, true);
    if (connector === null) return;
    const model = hiddenView(connector, this.p.ctx.clock.epochMs() / 1000, this.c.lang(click));
    await this.c.repost(click, viewMessage({ name: "remoteHidden", model }, model.title));
  }

  /** Show one hidden conversation (`ref`) again, or all of that machine's (`all`). */
  async unhide(click: Click): Promise<void> {
    const connector = await this.ownConnector(click, true);
    if (connector === null) return;
    const hidden = connector.agents.flatMap((a) => hiddenOf(a));
    const ref = textOf(click.data["ref"]);
    const refs = click.data["all"] ? hidden.map((e) => e.ref) : hidden.filter((e) => e.ref === ref).map((e) => e.ref);
    const lang = this.c.lang(click);
    if (refs.length === 0) return this.c.home(click, saidIn(lang, "conversationGone"));
    const out = await this.p.ctx.claw.hide(click.key, connector.connectorId, refs, false);
    await this.c.home(click, remoteText.in(lang).unhidN({ n: out.changed.length }));
  }

  /**
   * A tap on the disconnect card. The card names a connector id; whose it is is Claw's to say (404 for anyone else's), and the
   * machine's name is read again from the person's own list.
   */
  async off(click: Click): Promise<void> {
    const lang = this.c.lang(click);
    const words = remoteOffText.in(lang);
    if (!this.p.ctx.settings.enabled) return this.settled(click, words.inactive);
    if (click.data["confirm"] !== true) return this.settled(click, words.kept);
    const connectorId = textOf(click.data["connector_id"]);
    let connector: Connector | undefined;
    try {
      connector = connectorById((await this.p.lists.machines(click.key)).connectors, connectorId);
      if (connector === undefined) {
        await this.settled(click, words.gone);
        return;
      }
      await this.p.ctx.claw.revoke(click.key, connectorId);
    } catch (error) {
      return this.offRefused(click, error, connector?.name ?? "", lang);
    }
    const state = this.p.state.attached(click.chatKey);
    if (state?.connectorId === connectorId) {
      this.p.ops.leave(click.chatKey);
    }
    const login = connector.paired ? "" : (await this.p.lists.setup(click.key)).login();
    await this.c.end(click, disconnectedText(connector.name, login, lang, connector.paired));
  }

  /** The tap ends with `text` in place of the card. */
  private async settled(click: Click, text: string): Promise<void> {
    await this.c.end(click, text);
  }

  /** It did not go through: said; where pressing again can help, the card comes back with its buttons. */
  private async offRefused(click: Click, error: unknown, name: string, lang: Lang): Promise<void> {
    const words = remoteOffText.in(lang);
    const connectorId = textOf(click.data["connector_id"]);
    const again = async (text: string): Promise<void> => {
      await this.c.end(click, disconnectAgainCard(text, connectorId, disconnectTitle(name, lang), lang), text);
    };
    if (error instanceof RemoteOff) return this.settled(click, saidIn(lang, "notEnabled"));
    if (error instanceof ClawError) {
      if (error.status === 404) return this.settled(click, words.gone);
      return again(failureText(error, this.p.ctx.errors, this.p.ctx.clock.epochMs() / 1000, lang) + words.nothing);
    }
    if (isTransport(error)) return again(saidIn(lang, "unreachable") + words.nothing);
    throw error;
  }
}
