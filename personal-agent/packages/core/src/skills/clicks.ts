// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Undo, Edit and Save changes on a personal skill's card (`assistant_skill`). The card is not trusted: its buttons carry only the id
 * of the card this worker recorded (an `assistant_confirm_cards` row of kind `skill_undo`, naming the change and the skill), and
 * only the card's own person can press it. Undo takes back that one change in Claw, once (a press claims the card first, so of two
 * presses exactly one is sent); Edit shows the skill's text and description to change, and Save changes saves them as its next
 * version, shown as a new card whose Undo takes that back. Everything is done as the presser, with their own credential.
 */
import { viewMessage } from "../approvals/click.js";
import { ClawError } from "../claw/errors.js";
import { errorName } from "../errors.js";
import { skillText } from "../locales/skills.js";
import type { Lang } from "../locales/lang.js";
import type { ClawSkillsPort } from "../ports/claw/skills.js";
import type { ClickHandler, ClickRoute } from "../ports/routing.js";
import type { Logger } from "../ports/logger.js";
import type { ConfirmCard } from "../ports/store/assistant.js";
import type { StorePort } from "../ports/store/index.js";
import { cpLength, pyStr } from "../text/py-text.js";
import { finish } from "../assistant/finish.js";
import { clawFailure } from "../assistant/failures.js";
import { skillCardOfSkill } from "./card.js";
import { SKILL_EDIT_CONTENT, SKILL_EDIT_DESCRIPTION, SKILL_EDIT_MAX, SKILL_UNDO_KIND, SKILL_VERB } from "./views.js";

export interface SkillClickDeps {
  readonly store: Pick<StorePort, "assistantButtons">;
  readonly skills: ClawSkillsPort;
  readonly logger: Logger;
}

/** Why Claw refused (the `reason` of its answer), or "". */
export function refusalReason(error: ClawError): string {
  try {
    const body = JSON.parse(error.detail) as unknown;
    if (typeof body === "object" && body !== null) {
      const reason = (body as Record<string, unknown>)["reason"];
      return typeof reason === "string" ? reason : "";
    }
  } catch {
    // (not JSON: no reason)
  }
  return "";
}

/** Claw's own words for a refusal (its `error`), or the status. */
export function refusalWords(error: ClawError): string {
  try {
    const body = JSON.parse(error.detail) as unknown;
    const said = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["error"] : undefined;
    if (typeof said === "string" && said) return said;
  } catch {
    // (not JSON)
  }
  return `HTTP ${String(error.status)}`;
}

export class SkillCardClicks implements ClickHandler {
  readonly verbs = [SKILL_VERB] as const;

  constructor(private readonly deps: SkillClickDeps) {}

  async withCredential(click: ClickRoute, credential: string): Promise<void> {
    const data = click.action.data;
    const op = pyStr(data["op"]);
    const card = this.deps.store.assistantButtons.getConfirmCard(pyStr(data["card"]));
    const lang = click.lang();
    const t = skillText.in(lang);
    if (
      card === null ||
      card.userId !== click.sender.id ||
      card.kind !== SKILL_UNDO_KIND ||
      (op !== "undo" && op !== "edit" && op !== "save_edit")
    ) {
      await finish(click, t.gone);
      return;
    }
    if (card.state !== "open") {
      await finish(click, op === "undo" ? t.undoDone : t.gone);
      return;
    }
    if (op === "undo") await this.undo(click, card, credential, lang);
    else if (op === "edit") await this.edit(click, card, credential, lang);
    else await this.saveEdit(click, card, credential, lang);
  }

  private async undo(click: ClickRoute, card: ConfirmCard, credential: string, lang: Lang): Promise<void> {
    const t = skillText.in(lang);
    const buttons = this.deps.store.assistantButtons;
    if (!buttons.moveConfirmCard(card.cardId, "busy", { onlyFrom: "open" })) {
      await finish(click, t.undoDone); // (a double press loses here)
      return;
    }
    let undone;
    try {
      undone = await this.deps.skills.undo(credential, card.confirmationId);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      this.deps.logger.warn("a skill's change could not be undone", { error: errorName(error) });
      if (error instanceof ClawError && error.status < 500) {
        buttons.moveConfirmCard(card.cardId, "done");
        await finish(click, this.undoRefused(error, card.label, lang));
        return;
      }
      buttons.moveConfirmCard(card.cardId, "open", { onlyFrom: "busy" });
      await click.settle(t.failed, { announce: false });
      return;
    }
    buttons.moveConfirmCard(card.cardId, "done");
    const name = undone.name || card.label;
    const said =
      undone.undone === "deleted"
        ? t.undoneDeleted({ name })
        : undone.undone === "restored_version"
          ? t.undoneVersion({ name, version: undone.version ?? 0 })
          : undone.undone === "enabled"
            ? t.undoneEnabled({ name })
            : undone.undone === "disabled"
              ? t.undoneDisabled({ name })
              : t.undoneRestored({ name });
    await finish(click, said);
  }

  private undoRefused(error: ClawError, name: string, lang: Lang): string {
    const t = skillText.in(lang);
    const reason = refusalReason(error);
    if (error.status === 410 || reason === "expired") return t.undoExpired;
    if (reason === "undone") return t.undoDone;
    if (reason === "changed") return t.undoChanged({ name });
    if (reason === "full") return t.undoFull;
    return t.gone;
  }

  private async edit(click: ClickRoute, card: ConfirmCard, credential: string, lang: Lang): Promise<void> {
    const t = skillText.in(lang);
    let skill;
    try {
      skill = await this.deps.skills.show(credential, card.label);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      await finish(
        click,
        error instanceof ClawError && error.status === 404 ? t.notFound({ name: card.label }) : t.couldNotRead,
      );
      return;
    }
    if (cpLength(skill.content) > SKILL_EDIT_MAX) {
      await finish(click, t.editTooLong({ name: skill.name }));
      return;
    }
    const model = {
      cardId: card.cardId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      note: "",
      lang,
    };
    await click.settle(viewMessage({ name: "skillEdit", model }), { announce: false });
  }

  private async saveEdit(click: ClickRoute, card: ConfirmCard, credential: string, lang: Lang): Promise<void> {
    const t = skillText.in(lang);
    const buttons = this.deps.store.assistantButtons;
    const content = pyStr(click.action.data[SKILL_EDIT_CONTENT]);
    const description = pyStr(click.action.data[SKILL_EDIT_DESCRIPTION]).trim();
    const again = (note: string) =>
      click.settle(
        viewMessage({
          name: "skillEdit",
          model: { cardId: card.cardId, name: card.label, description, content, note, lang },
        }),
        { announce: false },
      );
    if (!content.trim()) {
      await again(t.refused({ why: "SKILL.md" }));
      return;
    }
    if (!buttons.moveConfirmCard(card.cardId, "busy", { onlyFrom: "open" })) {
      await finish(click, t.gone);
      return;
    }
    let change;
    try {
      change = await this.deps.skills.update(credential, card.label, { content, description });
    } catch (error) {
      if (!clawFailure(error)) throw error;
      buttons.moveConfirmCard(card.cardId, "open", { onlyFrom: "busy" });
      this.deps.logger.warn("a skill could not be saved from its card", { error: errorName(error) });
      await again(
        error instanceof ClawError && error.status < 500 ? t.refused({ why: refusalWords(error) }) : t.failed,
      );
      return;
    }
    buttons.moveConfirmCard(card.cardId, "done");
    let shown;
    try {
      shown = await this.deps.skills.show(credential, card.label);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      await finish(click, t.updatedTitle({ name: card.label, version: change.version ?? 0 }));
      return;
    }
    const next = change.changeId
      ? buttons.addConfirmCard(click.sender.id, change.changeId, SKILL_UNDO_KIND, card.label)
      : "";
    const skill = skillCardOfSkill(shown, "saved", change.changeId);
    const model = { skill, cardId: next, allowLabel: "", note: "", ended: false, lang };
    await click.settle(viewMessage({ name: "skillCard", model }), {
      fallback: t.updatedTitle({ name: shown.name, version: shown.version }),
    });
  }
}
