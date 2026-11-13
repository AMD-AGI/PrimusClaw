// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/skills`: the person's personal skills, in their own chat only (a group chat never lists them: `PERSONAL_ONLY_COMMANDS`).
 * `/skills` (or `list`) lists each with its version, whether it is off or used only when named, and when to use it; `show NAME` its
 * text and files; `disable NAME`, `enable NAME` and `delete NAME` do it at once, answered with the skill's card, whose Undo takes it
 * back for a day. All as the person, with their own credential.
 */
import { viewMessage } from "../approvals/click.js";
import { ClawError } from "../claw/errors.js";
import { clawFailure } from "../assistant/failures.js";
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import { skillText } from "../locales/skills.js";
import type { ClawSkillsPort, ClawSkillEntry } from "../ports/claw/skills.js";
import type { Logger } from "../ports/logger.js";
import type { CommandHandler, CommandRoute } from "../ports/routing.js";
import type { StorePort } from "../ports/store/index.js";
import { richMessage, textMessage } from "../ports/surface.js";
import { pySplit } from "../text/py-text.js";
import { skillCardOfSkill } from "./card.js";
import { SKILL_UNDO_KIND } from "./views.js";

export interface SkillsCommandDeps {
  readonly store: Pick<StorePort, "assistantButtons">;
  readonly skills: ClawSkillsPort;
  readonly logger: Logger;
}

/** The longest SKILL.md `/skills show` says whole (code points); a longer one is cut, with a note. */
export const SHOW_MAX = 3500;

type Act = "disable" | "enable" | "delete";

export class SkillsCommand implements CommandHandler {
  readonly name = "skills";

  constructor(private readonly deps: SkillsCommandDeps) {}

  async run(route: CommandRoute, args: string): Promise<boolean> {
    const lang = route.lang();
    const t = skillText.in(lang);
    const words = pySplit(args);
    const verb = (words[0] ?? "").toLowerCase();
    const name = words[1] ?? "";
    const say = (text: string) => route.conversation.send(textMessage(text));
    try {
      await this.dispatch(route, verb, words.length, name, lang);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      this.deps.logger.info("a /skills command could not be carried out", { error: errorName(error) });
      if (error instanceof ClawError && error.status === 404)
        await say(verb === "" || verb === "list" ? t.unavailable : t.notFound({ name }));
      else await say(t.couldNotRead);
    }
    return true;
  }

  private async dispatch(route: CommandRoute, verb: string, count: number, name: string, lang: Lang): Promise<void> {
    if (verb === "" || (verb === "list" && count === 1)) return this.list(route, lang);
    if (verb === "show" && count === 2) return this.show(route, name, lang);
    if ((verb === "disable" || verb === "enable" || verb === "delete") && count === 2)
      return this.act(route, verb, name, lang);
    await route.conversation.send(textMessage(skillText.in(lang).usage));
  }

  private state(s: ClawSkillEntry, lang: Lang): string {
    const t = skillText.in(lang);
    return `${s.enabled ? "" : t.stateOff}${s.invocation === "manual" ? t.stateManual : ""}`;
  }

  private async list(route: CommandRoute, lang: Lang): Promise<void> {
    const t = skillText.in(lang);
    const skills = await this.deps.skills.list(route.credential);
    if (!skills.length) {
      await route.conversation.send(textMessage(t.noSkills));
      return;
    }
    const lines = skills.map((s) =>
      t.listLine({
        name: s.name,
        version: s.version,
        description: s.description.replace(/\s+/gu, " "),
        state: this.state(s, lang),
      }),
    );
    await route.conversation.send(
      richMessage([`**${t.listTitle({ n: skills.length })}**`, ...lines, "", t.listHint].join("\n")),
    );
  }

  private async show(route: CommandRoute, name: string, lang: Lang): Promise<void> {
    const t = skillText.in(lang);
    const s = await this.deps.skills.show(route.credential, name);
    const chars = Array.from(s.content);
    const body = chars.length > SHOW_MAX ? `${chars.slice(0, SHOW_MAX).join("")}\n…` : s.content;
    const parts = [
      t.showHead({ name: s.name, version: s.version, state: this.state(s, lang) }),
      s.description,
      "```",
      body,
      "```",
    ];
    if (s.fileList.length) parts.push(t.showFiles({ files: s.fileList.map((f) => f.path).join(", ") }));
    await route.conversation.send(richMessage(parts.join("\n")));
  }

  private async act(route: CommandRoute, act: Act, name: string, lang: Lang): Promise<void> {
    const t = skillText.in(lang);
    const { skills, store } = this.deps;
    const before = (await skills.list(route.credential)).find((s) => s.name === name);
    if (before === undefined) {
      await route.conversation.send(textMessage(t.notFound({ name })));
      return;
    }
    const change =
      act === "delete"
        ? await skills.remove(route.credential, name)
        : await skills.setEnabled(route.credential, name, act === "enable");
    if (!change.changed) {
      await route.conversation.send(textMessage(t.already({ name, on: act === "enable" ? t.on : t.off })));
      return;
    }
    const kind = act === "delete" ? "deleted" : act === "enable" ? "enabled" : "disabled";
    const cardId = change.changeId
      ? store.assistantButtons.addConfirmCard(route.sender.id, change.changeId, SKILL_UNDO_KIND, name)
      : "";
    const skill = skillCardOfSkill(before, kind, change.changeId);
    const title =
      kind === "deleted"
        ? t.deletedTitle({ name })
        : kind === "enabled"
          ? t.enabledTitle({ name })
          : t.disabledTitle({ name });
    await route.conversation.send(
      viewMessage({ name: "skillCard", model: { skill, cardId, allowLabel: "", note: "", ended: false, lang } }, title),
    );
  }
}
