// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's cards (teams_agent/render.py work_button, work_buttons, work_card, work_done_card, note_card, board_buttons,
 * board_card, asked_section, action_buttons, action_card, confirm_write_card), and a choice put to the person. What they say is core's
 * (`assistantCardText`, the work item helpers); this draws it on the card kit. The buttons carry only the id of the card the
 * worker recorded: what a press means is read from the record, never from the click.
 */
import {
  BOARD_LINES,
  BOARD_SHOWN,
  LABEL_MAX,
  ago,
  askedMeaning,
  askedRow,
  assistantCardText,
  boardDetail,
  boardMeaning,
  itemLabel,
  markdownPlain,
  own,
  cardLang,
  workCardText,
  type ActionCardModel,
  type BoardModel,
  type BoardRetry,
  type ChoiceCardModel,
  type ChoiceChosenModel,
  type ConfirmWriteModel,
  type Lang,
  type ReviewAskedOfOther,
  type WorkCardModel,
  type WorkDoneModel,
  type WorkItem,
  type WorkNoteModel,
} from "@primusclaw/personal-agent";

import { clip } from "../../cards/cjk.js";
import type { CardElement } from "../../cards/json.js";
import type { Meaning, Tone } from "../../cards/kit.js";
import {
  BUTTONS_MAX,
  TITLE_MAX,
  badges,
  buttons,
  execute,
  fold,
  header,
  icon,
  message,
  note,
  row,
  section,
  text,
} from "../../cards/kit.js";
import type { Renderers, TeamsMessage } from "../registry.js";

type Texts = ReturnType<typeof assistantCardText.in>;

/** One button of a work item's card: accept, stop, retry (a task that failed or was stopped), watch or unwatch. */
export function workButton(op: string, cardId: string, title: string): CardElement {
  return execute(title, `primusclaw.work_${op}`, { primusclaw: "work", op, card: cardId });
}

/** Accept (only when a result waits, and only that version; the primary button) and Stop; Stop alone is a destructive primary. */
export function workButtons(cardId: string, version: number, canAccept: boolean, lang: string): CardElement[] {
  const t = assistantCardText.in(lang === "zh" ? "zh" : "en");
  const stop = workButton("stop", cardId, t.stop);
  if (canAccept) return buttons([workButton("accept", cardId, t.accept({ version })), stop]);
  return buttons([stop], "destructive");
}

/**
 * What replaces a card the person just pressed: a short note (under a header with `title`, in `tone`, when there is one), and the
 * buttons again when the press has to be repeated.
 */
export function noteCard(value: string, actions: CardElement[] = [], title = "", tone: Tone = "default"): TeamsMessage {
  const meanings: Partial<Record<Tone, Meaning>> = { good: "good", attention: "failed", warning: "needs_you" };
  const emoji = meanings[tone] ?? "notice";
  return message([...(title ? [header(title, { tone, emoji })] : []), text(value)], actions);
}

function workCard(model: WorkCardModel): TeamsMessage {
  const { item } = model;
  const lang = cardLang(model.lang, model.text, item.title);
  const t = assistantCardText.in(lang);
  const sub = item.canAccept ? t.resultReady({ version: item.resultVersion }) : t.waiting;
  const body = [header(markdownPlain(itemLabel(item)), { tone: "warning", subtitle: sub, emoji: "needs_you" })];
  if (model.text) body.push(text(workCardText(model.text)));
  if (model.note) body.push(text(model.note, { weight: "Bolder" }));
  if (item.canAccept) body.push(note(t.replyForChanges));
  const actions = workButtons(model.cardId, item.resultVersion, item.canAccept, lang);
  if (model.watching && item.kind === "task") {
    body.push(note(t.watchingHint));
    actions.push(workButton("unwatch", model.cardId, t.unwatch));
  } else if (model.watch && item.kind === "task") {
    body.push(note(t.watchHint));
    actions.push(workButton("watch", model.cardId, t.watch));
  }
  return message(body, actions);
}

function workDone(model: WorkDoneModel): TeamsMessage {
  const accepted = model.verb === "Accepted";
  const t = assistantCardText.in("en");
  return message([
    header(`${model.verb} ${markdownPlain(itemLabel(model.item))}`, {
      tone: accepted ? "good" : "default",
      subtitle: accepted ? t.version({ version: model.item.resultVersion }) : "",
      emoji: accepted ? "good" : "stopped",
    }),
  ]);
}

function workNote(model: WorkNoteModel): TeamsMessage {
  return noteCard(model.text, workButtons(model.cardId, model.version, model.canAccept, "en"));
}

/** The board's own buttons: Accept all (the primary button) and a Retry for each task that failed or was stopped. */
export function boardButtons(accept: readonly string[], retry: readonly BoardRetry[], lang: Lang): CardElement[] {
  const t = assistantCardText.in(lang);
  const out: CardElement[] = [];
  if (accept.length) {
    out.push(
      execute(t.acceptAll({ n: accept.length }), "primusclaw.work_accept_all", {
        primusclaw: "work",
        op: "accept_all",
        cards: [...accept],
      }),
    );
  }
  for (const { cardId, item } of retry.slice(0, BUTTONS_MAX - out.length)) {
    out.push(workButton("retry", cardId, t.retry({ seq: item.seq })));
  }
  return out.length ? buttons(out) : [];
}

/** The board's sections: (state, emoji, tone), needs you first. */
const SECTIONS: ReadonlyArray<readonly [string, Meaning, Tone]> = [
  ["needs_you", "needs_you", "warning"],
  ["in_progress", "working", "accent"],
  ["done", "good", "good"],
];

/** `rows` past the first `shown` behind one "N more ▾" line, and a note for what is past BOARD_LINES (`total` in all). */
function foldRest(foldId: string, rows: CardElement[], shown: number, total: number, t: Texts): CardElement[] {
  const out = [...rows.slice(0, shown), ...fold(foldId, rows.slice(shown), t.more({ n: rows.length - shown }))];
  if (total > BOARD_LINES) out.push(note(t.older({ n: total - BOARD_LINES })));
  return out;
}

function itemRow(item: WorkItem, now: number, lang: Lang): CardElement {
  const detail = [boardDetail(item, lang), ago(item.updatedAt, now, lang)].filter((p) => p).join(" · ");
  return row(
    item.itemId,
    boardMeaning(item),
    `**#${String(item.seq)}** ${markdownPlain(clip(item.title, LABEL_MAX))}`,
    markdownPlain(detail),
  );
}

function boardSection(
  column: readonly WorkItem[],
  kind: readonly [string, Meaning, Tone],
  model: BoardModel,
  lang: Lang,
) {
  const [state, emoji, tone] = kind;
  const t = assistantCardText.in(lang);
  const rows = column.slice(0, BOARD_LINES).map((item) => itemRow(item, model.now, lang));
  return [
    { ...section(icon(emoji, `${t.column({ state })} · ${String(column.length)}`), tone), id: `band-${emoji}` },
    ...foldRest(`more-${state}`, rows, own(BOARD_SHOWN, state) ?? 0, column.length, t),
  ];
}

/** The board's part for reviews the person asked of others: a heading with the count, then one line each. */
export function askedSection(asked: readonly ReviewAskedOfOther[], lang: Lang): CardElement[] {
  if (!asked.length) return [];
  const t = assistantCardText.in(lang);
  const rows = asked.slice(0, BOARD_LINES).map((a) => {
    const [pullWho, state] = askedRow(a, lang);
    return row(a.itemId, askedMeaning(a), markdownPlain(pullWho), markdownPlain(state));
  });
  return [
    { ...section(icon("handoff", t.askedTitle({ n: asked.length }))), id: "band-handoff" },
    ...foldRest("more-asked", rows, BOARD_SHOWN["in_progress"] ?? 0, asked.length, t),
  ];
}

function board(model: BoardModel): TeamsMessage {
  const { items } = model;
  const lang = cardLang(model.lang, ...items.slice(0, 5).map((i) => i.title));
  const t = assistantCardText.in(lang);
  const count = (state: string): number => items.filter((i) => i.boardState === state).length;
  const waiting = count("needs_you");
  const body: CardElement[] = [
    header(t.boardTitle, { subtitle: waiting ? t.boardWaiting({ n: waiting }) : t.boardNothing, emoji: "board" }),
    badges(
      SECTIONS.map(([state, meaning, tone]) => ({ meaning, label: t.badge({ state }), count: count(state), tone })),
    ),
  ];
  for (const kind of SECTIONS) {
    const column = items.filter((i) => i.boardState === kind[0]);
    if (column.length) body.push(...boardSection(column, kind, model, lang));
  }
  body.push(...askedSection(model.asked, lang)); // (reviews asked of others are theirs: beside, never in a column of the person's)
  return message(body, boardButtons(model.accept, model.retry, lang));
}

/** Run (primary) and Cancel under a command the assistant put to the person: the buttons carry only the card's id. */
export function actionButtons(cardId: string, lang: string): CardElement[] {
  const t = assistantCardText.in(lang === "zh" ? "zh" : "en");
  const button = (title: string, op: string) =>
    execute(title, `primusclaw.assistant_action_${op}`, { primusclaw: "assistant_action", op, card: cardId });
  return buttons([button(t.run, "run"), button(t.cancel, "cancel")]);
}

function actionCard(model: ActionCardModel): TeamsMessage {
  const lang = cardLang(model.lang, model.text);
  const t = assistantCardText.in(lang);
  return message(
    [
      header(t.runTitle, { tone: "accent", emoji: "needs_you" }),
      text(model.text),
      text(`\`${clip(model.command, LABEL_MAX).replace(/`/g, "")}\``, { size: "Small" }),
    ],
    actionButtons(model.cardId, lang),
  );
}

function confirmWrite(model: ConfirmWriteModel): TeamsMessage {
  const t = assistantCardText.in(model.lang === "zh" ? "zh" : "en");
  const button = (title: string, op: string) =>
    execute(title, `primusclaw.assistant_confirm_${op}`, { primusclaw: "assistant_confirm", op, card: model.cardId });
  return message(
    [header(t.confirmTitle, { tone: "warning", emoji: "needs_you" }), text(model.text)],
    buttons([button(model.allowLabel || t.confirm, "allow"), button(t.deny, "deny")]),
  );
}

/**
 * A choice put to the person: the words (when the card holds them), the options as radio buttons (check boxes when several may be
 * picked), and Send. Send carries the card's id and, as its input, the places of the options picked: what it sends is read from
 * the record. The person may also just reply in the chat.
 */
function choiceCard(model: ChoiceCardModel): TeamsMessage {
  const lang = cardLang(model.lang, model.text, ...model.options);
  const t = assistantCardText.in(lang);
  const body: CardElement[] = [
    header(model.multiple ? t.choiceTitleMany : t.choiceTitle, { tone: "accent", emoji: "question" }),
  ];
  if (model.text) body.push(text(model.text));
  body.push({
    type: "Input.ChoiceSet",
    id: "choice",
    style: "expanded",
    isMultiSelect: model.multiple,
    choices: model.options.map((option, i) => ({ title: clip(option, LABEL_MAX), value: String(i) })),
  });
  if (model.note) body.push(text(model.note, { weight: "Bolder" }));
  body.push(note(t.choiceTyped));
  const send = execute(t.choiceSend, "primusclaw.assistant_choice", {
    primusclaw: "assistant_choice",
    card: model.cardId,
  });
  return message(body, buttons([send]));
}

/** What replaces a choice card once sent: what was sent, under the words it answered. */
function choiceChosen(model: ChoiceChosenModel): TeamsMessage {
  const lang = cardLang(model.lang, model.text, ...model.chosen);
  const t = assistantCardText.in(lang);
  const answer = model.chosen.join(t.choiceJoin);
  const body = [header(t.choiceSent({ answer: clip(answer, TITLE_MAX) }), { tone: "good", emoji: "good" })];
  if (model.text) body.push(text(model.text, { subtle: true }));
  return message(body);
}

export const assistantRenderers = {
  actionCard,
  choiceCard,
  choiceChosen,
  board,
  confirmWrite,
  workCard,
  workDone,
  workNote,
} satisfies Partial<Renderers>;
