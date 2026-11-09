// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawError, ClawUnreachable, errorKind } from "../claw/errors.js";
import { parseClock } from "../commands/parse.js";
import type { JsonObject } from "../json.js";
import { briefText } from "../locales/brief.js";
import type { Lang } from "../locales/lang.js";
import type { ClawAssistantPort } from "../ports/claw/assistant.js";
import type { ClawTriggersPort } from "../ports/claw/settings.js";
import type { Logger } from "../ports/logger.js";
import type { CommandHandler, CommandRoute } from "../ports/routing.js";
import type { LinkRepository } from "../ports/store/link.js";
import type { PrefsRepository } from "../ports/store/people.js";
import { richMessage, textMessage } from "../ports/surface.js";
import { decimalInt, pySplit, pyStr } from "../text/py-text.js";
import { DAILY_BRIEF } from "./template.js";

/**
 * `/brief`: the daily brief. `/brief on [HH:MM]` makes (or refreshes) the person's weekday trigger in their time zone,
 * `/brief off` removes it, `/brief` says whether it is on, and with the assistant `/brief` and `/brief now` show the brief
 * itself, put together by Claw at once. A trigger keeps a copy of the key it was made with, so it must be the person's
 * own linked key, never an exchanged token.
 */

export interface BriefDeps {
  /** Off until Claw's trigger API is deployed: the command then says so. */
  readonly enabled: boolean;
  readonly links: Pick<LinkRepository, "getKey">;
  readonly prefs: Pick<PrefsRepository, "getPrefs" | "setBriefTrigger">;
  readonly triggers: ClawTriggersPort;
  readonly assistant: Pick<ClawAssistantPort, "brief">;
  /** A 1:1 chat that talks to the person's assistant. */
  readonly assistantOn: (userId: string) => boolean;
  /** The brief Claw answered, as the message that shows it (the assistant's view of it). */
  readonly briefMarkdown: (brief: JsonObject) => string;
  readonly log: Logger;
}

type Say = (text: string) => Promise<void>;

export class DailyBrief implements CommandHandler {
  readonly name = "brief";

  constructor(private readonly deps: BriefDeps) {}

  async run(route: CommandRoute, args: string): Promise<boolean> {
    const lang = route.lang();
    const T = briefText.in(lang);
    const say: Say = (text) => route.conversation.send(textMessage(text));
    if (!this.deps.enabled) {
      await say(T.unavailable);
      return true;
    }
    const key = this.deps.links.getKey(route.sender.id);
    if (key === null) {
      await say(briefText.in("en").needsKey);
      return true;
    }
    try {
      await this.dispatch(route, key, args, lang, say);
    } catch (err) {
      if (!(err instanceof ClawError)) throw err;
      const en = briefText.in("en");
      if (err.status === 404) await say(en.noTriggers);
      else if (err.status === 409) await say(en.tooMany);
      else await say(en.refused({ status: err.status }));
    }
    return true;
  }

  private async dispatch(route: CommandRoute, key: string, args: string, lang: Lang, say: Say): Promise<void> {
    const words = pySplit(args);
    const verb = (words[0] ?? "").toLowerCase();
    const userId = route.sender.id;
    if (verb === "on" && words.length <= 2)
      return this.turnOn(userId, key, words[1] ?? DAILY_BRIEF.defaultTime, lang, say);
    if (verb === "off" && words.length === 1) return this.turnOff(userId, key, lang, say);
    if (args === "" || (verb === "now" && words.length === 1)) {
      if (this.deps.assistantOn(userId)) return this.showNow(route, key, lang, verb === "now");
      return say(this.state(await this.find(userId, key), lang));
    }
    return say(briefText.in("en").usage({ assistant: this.deps.assistantOn(userId) }));
  }

  /** The person's brief trigger: the one recorded, else one of the brief's name. */
  private async find(userId: string, key: string): Promise<JsonObject | undefined> {
    const known = this.deps.prefs.getPrefs(userId).briefTriggerId;
    const triggers = await this.deps.triggers.list(key);
    return triggers.find((t) => t["trigger_id"] === known || t["name"] === DAILY_BRIEF.name);
  }

  private state(found: JsonObject | undefined, lang: Lang): string {
    const T = briefText.in(lang);
    if (!found) return T.isOff;
    return T.isOn({ schedule: pyStr(found["schedule"]), timezone: pyStr(found["timezone"]) });
  }

  /** The brief itself, now, as one message; `/brief` adds whether it comes on its own, `/brief now` is the brief alone. */
  private async showNow(route: CommandRoute, key: string, lang: Lang, alone: boolean): Promise<void> {
    const userId = route.sender.id;
    let state: string | undefined;
    if (!alone) {
      try {
        state = this.state(await this.find(userId, key), lang);
      } catch (err) {
        if (!(err instanceof ClawError || err instanceof ClawUnreachable)) throw err;
        state = undefined; // (the brief is still shown; only its schedule could not be read)
      }
    }
    let brief: JsonObject;
    try {
      brief = await this.deps.assistant.brief(key, lang, this.deps.prefs.getPrefs(userId).timezone);
    } catch (err) {
      if (!(err instanceof ClawError || err instanceof ClawUnreachable)) throw err;
      this.deps.log.warn("the brief could not be read", { why: errorKind(err) });
      await route.conversation.send(textMessage(briefText.in(lang).unreadable));
      return;
    }
    const text = this.deps.briefMarkdown(brief) + (state ? `\n\n${state}` : "");
    await route.conversation.send(richMessage(text));
  }

  private async turnOn(userId: string, key: string, at: string, lang: Lang, say: Say): Promise<void> {
    const clock = parseClock(at);
    if (clock === null) return say(briefText.in("en").badTime);
    const [hour = "0", minute = "0"] = clock.split(":");
    const schedule = `${String(decimalInt(minute))} ${String(decimalInt(hour))} * * ${DAILY_BRIEF.days}`;
    const timezone = this.deps.prefs.getPrefs(userId).timezone;
    // With the assistant the brief is Claw's own, said through the assistant when it fires; without it, a run of the
    // daily-brief skill. A brief of the other kind is replaced, so moving to the assistant moves the brief too.
    const action = this.deps.assistantOn(userId) ? "brief" : "";
    const input = { name: DAILY_BRIEF.name, prompt: DAILY_BRIEF.prompt, schedule, timezone };
    const existing = await this.find(userId, key);
    let trigger: JsonObject;
    if (existing && (pyStr(existing["action"]) || "run") === (action || "run")) {
      trigger = await this.deps.triggers.update(key, pyStr(existing["trigger_id"]), input); // also refreshes its key
    } else {
      trigger = await this.deps.triggers.create(key, action ? { ...input, action } : input);
      // a brief of the other kind is removed only once the new one exists: a refusal keeps the old
      if (existing) await this.deps.triggers.delete(key, pyStr(existing["trigger_id"]));
    }
    this.deps.prefs.setBriefTrigger(userId, pyStr(trigger["trigger_id"]));
    const T = briefText.in(lang);
    return say(action ? T.onAssistant({ clock, timezone }) : T.onSkill({ clock, timezone }));
  }

  private async turnOff(userId: string, key: string, lang: Lang, say: Say): Promise<void> {
    const existing = await this.find(userId, key);
    if (existing) await this.deps.triggers.delete(key, pyStr(existing["trigger_id"]));
    this.deps.prefs.setBriefTrigger(userId, null);
    const T = briefText.in(lang);
    return say(existing ? T.off : T.wasNotOn);
  }
}
