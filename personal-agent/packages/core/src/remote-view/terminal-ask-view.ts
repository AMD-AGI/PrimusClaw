// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of a question a terminal asks: a coding agent its person started in their own terminal wants to run a command, change
 * a file, start on a plan or have a multiple-choice question answered, and the connector's approval hooks put it here too
 * (`remote.ask` with `origin: "terminal"`). The terminal keeps asking: the first answer counts.
 *
 * Nothing is approved unseen. The card shows the request whole (the connector and Claw carry it whole, credentials masked); a
 * request whose content did not come (Claw leaves it out past its size), or that is longer than a card shows, keeps only the
 * options that turn it down, and says to approve it at the terminal. So does one the card cannot show as it is: a credential
 * masked in it (a mask can hide more than the credential), or a character the card does not show as itself.
 */
import type { Lang } from "../locales/lang.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";
import type { DecisionButton } from "../remote/actions.js";
import { breakLinks, lit, masked, neutral } from "../remote/inert.js";
import { type PermissionOption, shownOptions } from "../remote/options.js";
import type { Reported } from "../remote/reported.js";
import { redactText } from "../security/redact.js";
import { neutral as neutralLine } from "../text/neutral.js";
import { pyStr } from "../text/py-text.js";
import { optionButtons } from "./permission-view.js";

/**
 * The most of a request's content a card shows, in characters. A Teams card carries about 28 KB; the content Claw sends is at
 * most 16 KiB of JSON, and what is shown of it (unescaped, without the JSON's quoting) is no longer.
 */
export const TERMINAL_CONTENT_MAX = 16_000;
/** The most bytes of rendered content (as the card's JSON carries it) a card holds, leaving room under Teams' ~28 KB for the rest. */
export const TERMINAL_CARD_BYTES = 20_000;
/** The content budget of the cut-short card a channel falls back to. */
export const TERMINAL_FALLBACK_BYTES = 4_000;

/** How long one line of a card may be (a description, a header, a path, an answer's label or meaning) before it is cut. */
const LINE_MAX = 400;
const LABEL_MAX = 200;
/** The longest option name a card writes out whole (the connector names an "always" option with the rule it adds). */
const OPTION_NAME_MAX = 200;

/** One piece of a terminal request's content. `code`: shown as it is, in a fixed-width font; `words`: markdown kept, links not. */
export type TerminalSection =
  | { readonly type: "line"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "words"; readonly text: string }
  | { readonly type: "option"; readonly label: string; readonly description: string };

export interface TerminalAskView {
  readonly lang: Lang;
  readonly title: string;
  /** Whose agent asks, on which machine, in which project. */
  readonly who: string;
  /** What it asks, before the content ("wants to run:"). */
  readonly asks: string;
  readonly sections: readonly TerminalSection[];
  readonly notes: readonly string[];
  readonly buttons: readonly DecisionButton[];
  /** The whole request is on the card (else only the options that turn it down are). */
  readonly complete: boolean;
  /**
   * The same card cut short (content within TERMINAL_FALLBACK_BYTES, only the options that turn it down, no "always" notes): what
   * a channel sends when the card as built is larger than it can carry. Absent on the fallback itself.
   */
  readonly fallback?: TerminalAskView;
}

export interface TerminalAsk {
  /** `remote.ask` as Claw relayed it: `action_id`, `tool`, `kind`, `input`, `question_index`, `question_count`. */
  readonly ask: Reported;
  readonly options: readonly PermissionOption[];
  readonly sessionId: string;
  readonly machine: string;
  readonly agent: string;
}

/** Whether `remote.ask` is a question a terminal asks (a connector's approval hooks), not one an agent Claw started asks. */
export function isTerminalAsk(ask: Reported | undefined): boolean {
  return ask !== undefined && ask["origin"] === "terminal";
}

const record = (v: unknown): Reported | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Reported) : undefined;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The characters a fixed-width block escapes: markdown's (`plain`'s) and `>`, the backslash among them. */
const CODE_MARKUP = /[\\`*_[\]<>]/g;
/**
 * `<` and `>` in words escaped as markdown, with every backslash in the run right before one (so `\<` is still shown as
 * written): shown as themselves, not as look-alikes (a card must show a `>` as `>`; no tag can be built in a card either way).
 * A run of backslashes is matched whole, so the scan stays linear.
 */
const ANGLES = /\\+[<>]?|[<>]/g;
const angles = (v: string): string =>
  v.replace(ANGLES, (run) => (/[<>]$/.test(run) ? run.replace(/[\\<>]/g, "\\$&") : run));
/** Text shown as it is, in a fixed-width font: credentials masked, no link or markup can be built from it. */
const codeText = (v: string): string => breakLinks(masked(v)).replace(CODE_MARKUP, "\\$&");
/** Text whose markdown (lists, bold) is kept, but no link can be built from it (`](` gets a zero-width space inside). */
const wordsText = (v: string): string => breakLinks(angles(masked(v)).replaceAll("](", "]\u200b("));

/**
 * A character a card does not show as itself: a control character (but a line break or a tab), or an invisible format character
 * (a bidi override that reorders what is shown, a zero-width space, a soft hyphen).
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for
const UNSHOWN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}]/u;
/**
 * Whether `text` is shown as it is: no credential masked in it (the private-key mask runs to the end of a key that is never
 * closed, hiding whatever follows it) and no character the card does not show as itself.
 */
const shownAsIs = (text: string): boolean => !UNSHOWN.test(text) && !redactText(text).masked;
/** Whether a one-line text (a path, a tool, an "always" rule) is shown exactly: `neutral` changes nothing in it. */
const lineAsIs = (text: string): boolean => shownAsIs(text) && neutralLine(text, Infinity) === text;
/** Whether a section is shown as it is (see `shownAsIs`). */
const sectionAsIs = (s: TerminalSection): boolean =>
  s.type === "option" ? shownAsIs(s.label) && shownAsIs(s.description) : shownAsIs(s.text);

/** The localized title of an option the connector names by a known id; a question's answers keep their own labels. */
function optionTitle(option: PermissionOption, lang: Lang): string | undefined {
  const words = terminalApprovalText.in(lang);
  const titles = new Map<string, string>([
    ["allow", words.optionYes],
    ["allow-session", words.optionSession],
    ["deny", words.optionNo],
    ["deny-stop", words.optionNoStop],
    ["plan-approve", words.optionPlanApprove],
    ["plan-keep", words.optionPlanKeep],
  ]);
  return titles.get(option.optionId);
}

interface Content {
  readonly asks: string;
  readonly sections: TerminalSection[];
  /** The input's fields it shows (every other one is shown as JSON after them). */
  readonly fields: readonly string[];
  /** A line it shows was too long to show whole (the path in its first line). */
  readonly clipped?: boolean;
}
type Words = ReturnType<typeof terminalApprovalText.in>;

function commandContent(input: Reported, words: Words): Content | undefined {
  const command = input["command"];
  if (typeof command !== "string") return undefined;
  const description = str(input["description"]);
  const sections: TerminalSection[] = [{ type: "code", text: command }];
  if (description) sections.push({ type: "line", text: description });
  return { asks: words.asksRun, sections, fields: ["command", "description"] };
}

function editContent(input: Reported, words: Words): Content | undefined {
  const path = str(input["file_path"]) || str(input["notebook_path"]);
  if (!path) return undefined;
  const sections: TerminalSection[] = [];
  if (typeof input["content"] === "string") sections.push({ type: "code", text: input["content"] });
  if (typeof input["old_string"] === "string" || typeof input["new_string"] === "string") {
    sections.push({ type: "line", text: words.oldText }, { type: "code", text: str(input["old_string"]) });
    sections.push({ type: "line", text: words.newText }, { type: "code", text: str(input["new_string"]) });
  }
  if (typeof input["new_source"] === "string") sections.push({ type: "code", text: input["new_source"] });
  return {
    asks: words.asksEdit({ path: neutral(path, LINE_MAX) }),
    sections,
    fields: ["file_path", "notebook_path", "content", "old_string", "new_string", "new_source"],
    clipped: path.length > LINE_MAX || !lineAsIs(path),
  };
}

function planContent(input: Reported, words: Words): Content | undefined {
  const plan = input["plan"];
  return typeof plan === "string"
    ? { asks: words.asksPlan, sections: [{ type: "words", text: plan }], fields: ["plan"] }
    : undefined;
}

function questionContent(input: Reported, words: Words): Content | undefined {
  const question = input["question"];
  if (typeof question !== "string") return undefined;
  const header = str(input["header"]);
  const options = Array.isArray(input["options"]) ? input["options"] : [];
  const sections: TerminalSection[] = header ? [{ type: "line", text: header }] : [];
  sections.push({ type: "words", text: question });
  const extras: Reported[] = [];
  for (const o of options as unknown[]) {
    const r = record(o);
    sections.push({ type: "option", label: str(r?.["label"]), description: str(r?.["description"]) });
    // (an answer that is not an object, or carries fields beyond its label and meaning, is shown whole after the answers)
    const rest = r
      ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "label" && k !== "description"))
      : { value: o };
    if (Object.keys(rest).length) extras.push(rest);
  }
  if (extras.length) sections.push({ type: "code", text: JSON.stringify(extras, null, 2) });
  // (a header or answers of another shape are not rendered here: they go after it as JSON with every other field)
  // (answers that are not a list of objects are not what a question carries: shown, but never answerable from here)
  const malformed = !Array.isArray(input["options"]) || options.some((o) => record(o) === undefined);
  const fields = [
    "question",
    ...(typeof input["header"] === "string" ? ["header"] : []),
    ...(Array.isArray(input["options"]) ? ["options"] : []),
  ];
  return { asks: words.asksQuestion, sections, fields, clipped: malformed };
}

const CONTENT = new Map<string, (input: Reported, words: Words) => Content | undefined>([
  ["execute", commandContent],
  ["edit", editContent],
  ["switch_mode", planContent],
  ["question", questionContent],
]);

/**
 * What a request shows, by its kind; any other (or one whose fields are not what its kind has) as its JSON. Whatever fields its
 * kind does not show are shown after it as JSON: the card shows the request whole.
 */
function contentOf(kind: string, tool: string, input: Reported | undefined, words: Words): Content {
  const generic: Content = {
    asks: words.asksTool({ tool: neutral(tool, 120) }),
    sections: [],
    fields: [],
    clipped: tool.length > 120 || !lineAsIs(tool),
  };
  if (input === undefined) return generic;
  const shown = CONTENT.get(kind)?.(input, words);
  if (shown === undefined) return { ...generic, sections: [{ type: "code", text: JSON.stringify(input, null, 2) }] };
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !shown.fields.includes(k)));
  if (Object.keys(rest).length === 0) return shown;
  return { ...shown, sections: [...shown.sections, { type: "code", text: JSON.stringify(rest, null, 2) }] };
}

const sectionChars = (s: TerminalSection): number =>
  s.type === "option" ? s.label.length + s.description.length : s.text.length;

/** Whether a section is longer than the card shows one of its kind (a line, a label): then the request is not shown whole. */
const sectionClipped = (s: TerminalSection): boolean =>
  s.type === "option"
    ? s.label.length > LABEL_MAX || s.description.length > LINE_MAX
    : s.type === "line" && s.text.length > LINE_MAX;

/** One section made inert for a card, cut to `left` characters. */
function inert(s: TerminalSection, left: number): TerminalSection {
  if (s.type === "option")
    return { type: "option", label: lit(s.label, LABEL_MAX), description: lit(s.description, LINE_MAX) };
  const piece = s.text.length > left ? `${s.text.slice(0, left)}…` : s.text;
  if (s.type === "code") return { type: "code", text: codeText(piece) };
  if (s.type === "words") return { type: "words", text: wordsText(piece) };
  return { type: "line", text: lit(piece, LINE_MAX) };
}

const UTF8 = new TextEncoder();
/**
 * What one section costs a card beyond its text: the element it is drawn as (`{"type":"TextBlock","text":...,"wrap":true,...}`,
 * an answer's bold and dash). Counted so that many short sections (hundreds of answers) cannot outgrow the card either.
 */
const SECTION_OVERHEAD = 128;
/** What a section adds to the card as sent: its rendered text as JSON (escaping counted), in UTF-8 bytes. */
const renderedBytes = (s: TerminalSection): number =>
  SECTION_OVERHEAD + UTF8.encode(JSON.stringify(s.type === "option" ? [s.label, s.description] : s.text)).length;

/**
 * The sections as the card shows them, and whether all of them fit whole: at most TERMINAL_CONTENT_MAX characters of the
 * request, and at most TERMINAL_CARD_BYTES of rendered text, so the card always goes out (what is cut is never offered for
 * approval). Escaping can make the rendered text several times longer than the request.
 */
function shownSections(
  sections: readonly TerminalSection[],
  budget: number,
): { shown: TerminalSection[]; whole: boolean } {
  const shown: TerminalSection[] = [];
  let chars = TERMINAL_CONTENT_MAX;
  let bytes = budget;
  for (const s of sections) {
    if (chars <= 0 || bytes <= 0) return { shown, whole: false };
    const out = inert(s, chars);
    if (renderedBytes(out) > bytes) {
      // the longest prefix whose rendered text fits what is left
      let lo = 0;
      let hi = s.type === "option" ? 0 : Math.min(s.text.length, chars);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (renderedBytes(inert(s, mid)) <= bytes) lo = mid;
        else hi = mid - 1;
      }
      if (s.type !== "option" && lo > 0) shown.push(inert(s, lo));
      return { shown, whole: false };
    }
    shown.push(out);
    chars -= sectionChars(s);
    bytes -= renderedBytes(out);
  }
  return { shown, whole: chars >= 0 };
}

function notesOf(ask: Reported, complete: boolean, options: readonly PermissionOption[], words: Words): string[] {
  const notes: string[] = [];
  const total = Number(ask["question_count"]);
  const index = Number(ask["question_index"]);
  if (Number.isInteger(total) && total > 1 && Number.isInteger(index))
    notes.push(words.questionOf({ n: index + 1, of: total }));
  if (!complete) notes.push(words.tooLong);
  // (a button shows 40 characters: what an "always" option grants is written out whole here, or the option is not offered)
  // (only the options shown as buttons, at most four: their notes stay within what the card's byte budget leaves room for)
  for (const o of shownOptions(options))
    if (o.kind === "allow_always") notes.push(words.alwaysOption({ name: lit(o.name, OPTION_NAME_MAX) }));
  notes.push(words.firstAnswerWins);
  return notes;
}

/** The card of a question a terminal asks. */
export function terminalAskView(input: TerminalAsk, lang: Lang = "en"): TerminalAskView {
  return { ...buildView(input, lang, false), fallback: buildView(input, lang, true) };
}

/** The card; `cut`: the cut-short one a channel falls back to (never approvable). */
function buildView(input: TerminalAsk, lang: Lang, cut: boolean): TerminalAskView {
  const words = terminalApprovalText.in(lang);
  const ask = input.ask;
  const raw = record(ask["input"]);
  const content = contentOf(str(ask["kind"]), str(ask["tool"]), raw, words);
  const rendered = shownSections(content.sections, cut ? TERMINAL_FALLBACK_BYTES : TERMINAL_CARD_BYTES);
  const complete =
    !cut &&
    raw !== undefined &&
    content.clipped !== true &&
    rendered.whole &&
    !content.sections.some(sectionClipped) &&
    content.sections.every(sectionAsIs) &&
    content.sections.reduce((n, s) => n + sectionChars(s), 0) <= TERMINAL_CONTENT_MAX;
  // Cut, never shown in part with a way to approve it: what was cut is what would run. An "always" option whose name (the
  // rule it adds) cannot be written out whole is not offered either.
  const options = (complete ? input.options : input.options.filter((o) => o.kind.startsWith("reject"))).filter(
    (o) => o.kind !== "allow_always" || (o.name.trim() !== "" && o.name.length <= OPTION_NAME_MAX && lineAsIs(o.name)),
  );
  const buttons = optionButtons(options, input.sessionId, pyStr(ask["action_id"]), lang).map((b) => {
    const option = options.find((o) => o.optionId === b.optionId);
    const title = option ? optionTitle(option, lang) : undefined;
    return title ? { ...b, title } : b;
  });
  return {
    lang,
    title: words.title,
    who: words.who({
      agent: lit(input.agent || "Claude Code", 40),
      host: lit(input.machine, 60),
      project: lit(projectOf(ask), 80),
    }),
    asks: content.asks,
    sections: rendered.shown,
    notes: notesOf(ask, complete, options, words),
    buttons,
    complete,
  };
}

/** The project the request is about: the conversation's title, else the last folder of its working directory, when Claw relayed them. */
function projectOf(ask: Reported): string {
  const title = str(ask["title"]);
  if (title) return title;
  return str(ask["cwd"]).split("/").filter(Boolean).pop() ?? "";
}
