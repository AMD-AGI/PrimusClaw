// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { parseDurationSeconds, parseQuietWindow } from "../commands/parse.js";
import { settingsText } from "../locales/settings.js";
import { PAUSE_FOREVER } from "../ports/store/policy.js";
import { cpHead, pyLower } from "../text/py-text.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { hhmm, isTimeZone, two, wallClock, zoneOf } from "./time.js";

/**
 * The person's own settings of when they are reached (the Python `Agent._cmd_timezone`, `_cmd_quiet`, `_cmd_pause`,
 * `_cmd_resume`): every reply in their language, and what quiet hours or a pause held is delivered as soon as nothing
 * mutes them any more.
 */
export class SettingsCommands {
  constructor(private readonly ctx: RouterContext) {}

  async timezone(chat: Chat, name: string | null): Promise<void> {
    const { prefs } = this.ctx.deps.store;
    const said = settingsText.in(chat.lang());
    if (name === null) {
      await chat.say(said.zoneIs({ zone: prefs.getTimezone(chat.sender.id) }));
      return;
    }
    if (!isTimeZone(name)) {
      await chat.say(said.zoneUnknown({ name: cpHead(name, 64) }));
      return;
    }
    prefs.setTimezone(chat.sender.id, name);
    await chat.say(said.zoneSet({ zone: name }));
  }

  async quiet(chat: Chat, arg: string): Promise<void> {
    const { prefs } = this.ctx.deps.store;
    const current = prefs.getPrefs(chat.sender.id);
    const said = settingsText.in(chat.lang());
    if (arg === "") {
      const state = current.quietEnabled
        ? said.quietState({ start: current.quietStart, end: current.quietEnd, zone: current.timezone })
        : said.quietOffState;
      await chat.say(said.quietShow({ state }));
      return;
    }
    if (pyLower(arg) === "off") {
      prefs.setQuiet(chat.sender.id, null);
      await chat.say(said.quietOff);
    } else {
      const window = parseQuietWindow(arg);
      if (window === null) {
        await chat.say(said.quietUsage);
        return;
      }
      prefs.setQuiet(chat.sender.id, window);
      await chat.say(said.quietSet({ start: window[0], end: window[1], zone: current.timezone }));
    }
    await this.releaseIfOpen(chat.sender.id);
  }

  async pause(chat: Chat, arg: string): Promise<void> {
    const { store } = this.ctx.deps;
    const current = store.prefs.getPrefs(chat.sender.id);
    const said = settingsText.in(chat.lang());
    let until = PAUSE_FOREVER;
    let when = said.pauseForever;
    if (arg !== "") {
      const seconds = parseDurationSeconds(arg);
      if (seconds === null) {
        await chat.say(said.pauseUsage);
        return;
      }
      until = store.now() + seconds;
      const wall = wallClock(until, zoneOf(current.timezone));
      when = said.pauseUntil({
        weekday: wall.weekday,
        clock: hhmm(wall),
        month: two(wall.month),
        day: two(wall.day),
        zone: current.timezone,
      });
    }
    store.prefs.setPausedUntil(chat.sender.id, until);
    await chat.say(said.paused({ until: when }));
  }

  async resume(chat: Chat): Promise<void> {
    const { store, proactive } = this.ctx.deps;
    const current = store.prefs.getPrefs(chat.sender.id);
    const wasPaused = current.pausedUntil !== null && store.now() < current.pausedUntil;
    store.prefs.setPausedUntil(chat.sender.id, null);
    const said = settingsText.in(chat.lang());
    let text = wasPaused ? said.resumed : said.notPaused;
    if (proactive.muted(chat.sender.id)) text += said.stillQuiet({ start: current.quietStart, end: current.quietEnd });
    await chat.say(text);
    await this.releaseIfOpen(chat.sender.id);
  }

  /** After a change: when nothing mutes the person any more, what was held is delivered. */
  private async releaseIfOpen(userId: string): Promise<void> {
    if (this.ctx.deps.proactive.muted(userId) === null) await this.ctx.deps.proactive.release(userId);
  }
}
