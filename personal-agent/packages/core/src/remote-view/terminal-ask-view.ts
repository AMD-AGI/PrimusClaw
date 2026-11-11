// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of a question a terminal asks: a coding agent its person started in their own terminal wants to run a command, change
 * a file, start on a plan or have a multiple-choice question answered, and the connector's approval hooks put it here too
 * (`remote.ask` with `origin: "terminal"`). The terminal keeps asking: the first answer counts.
 *
 * Nothing is approved unseen. The card shows the request whole (the connector and Claw carry it whole, credentials masked); a
 * request whose content did not come (Claw leaves it out past its size), or that is longer than a card shows, keeps only the
 * options that turn it down, and says to approve it at the terminal.
 */
import type { Lang } from "../locales/lang.js";
import { terminalApprovalText } from "../locales/terminal-approvals.js";
import type { DecisionButton } from "../remote/actions.js";
import { breakLinks, inertLinks, lit, masked, neutral, plain } from "../remote/inert.js";
import type { PermissionOption } from "../remote/options.js";
import type { Reported } from "../remote/reported.js";
import { pyStr } from "../text/py-text.js";
import { optionButtons } from "./permission-view.js";

/**
 * The most of a request's content a card shows, in characters. A Teams card carries about 28 KB; the content Claw sends is at
 * most 16 KiB of JSON, and what is shown of it (unescaped, without the JSON's quoting) is no longer.
 */
export const TERMINAL_CONTENT_MAX = 16_000;

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

/** Text shown as it is, in a fixed-width font: credentials masked, no link or markup can be built from it. */
const codeText = (v: string): string => plain(breakLinks(inertLinks(masked(v))));
/** Text whose markdown (lists, bold) is kept, but no link or tag can be built from it. */
const wordsText = (v: string): string => breakLinks(inertLinks(masked(v)));

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
}
type Words = ReturnType<typeof terminalApprovalText.in>;

const EDIT_FIELDS = ["file_path", "notebook_path", "content", "old_string", "new_string", "new_source"];

function commandContent(input: Reported, words: Words): Content | undefined {
  const command = input["command"];
  if (typeof command !== "string") return undefined;
  const description = str(input["description"]);
  const sections: TerminalSection[] = [{ type: "code", text: command }];
  if (description) sections.push({ type: "line", text: description });
  return { asks: words.asksRun, sections };
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
  // (whatever else the edit carries is shown too: the card shows the request whole)
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !EDIT_FIELDS.includes(k)));
  if (Object.keys(rest).length) sections.push({ type: "code", text: JSON.stringify(rest, null, 2) });
  return { asks: words.asksEdit({ path: neutral(path, 200) }), sections };
}

function planContent(input: Reported, words: Words): Content | undefined {
  const plan = input["plan"];
  return typeof plan === "string" ? { asks: words.asksPlan, sections: [{ type: "words", text: plan }] } : undefined;
}

function questionContent(input: Reported, words: Words): Content | undefined {
  const question = input["question"];
  if (typeof question !== "string") return undefined;
  const header = str(input["header"]);
  const options = Array.isArray(input["options"]) ? input["options"] : [];
  const sections: TerminalSection[] = header ? [{ type: "line", text: header }] : [];
  sections.push({ type: "words", text: question });
  for (const o of options) {
    const r = record(o) ?? {};
    sections.push({ type: "option", label: str(r["label"]), description: str(r["description"]) });
  }
  return { asks: words.asksQuestion, sections };
}

const CONTENT = new Map<string, (input: Reported, words: Words) => Content | undefined>([
  ["execute", commandContent],
  ["edit", editContent],
  ["switch_mode", planContent],
  ["question", questionContent],
]);

/** What a request shows, by its kind; any other (or one whose fields are not what its kind has) as its JSON. */
function contentOf(kind: string, tool: string, input: Reported | undefined, words: Words): Content {
  const generic = { asks: words.asksTool({ tool: neutral(tool, 120) }), sections: [] as TerminalSection[] };
  if (input === undefined) return generic;
  const shown = CONTENT.get(kind)?.(input, words);
  return shown ?? { ...generic, sections: [{ type: "code", text: JSON.stringify(input, null, 2) }] };
}

const sectionChars = (s: TerminalSection): number =>
  s.type === "option" ? s.label.length + s.description.length : s.text.length;

/** One section made inert for a card, cut to `left` characters. */
function inert(s: TerminalSection, left: number): TerminalSection {
  if (s.type === "option") return { type: "option", label: lit(s.label, 200), description: lit(s.description, 300) };
  const piece = s.text.length > left ? `${s.text.slice(0, left)}…` : s.text;
  if (s.type === "code") return { type: "code", text: codeText(piece) };
  if (s.type === "words") return { type: "words", text: wordsText(piece) };
  return { type: "line", text: lit(piece, 400) };
}

/** The sections as the card shows them: at most TERMINAL_CONTENT_MAX characters (what is cut is never offered for approval). */
function shownSections(sections: readonly TerminalSection[]): TerminalSection[] {
  const out: TerminalSection[] = [];
  let left = TERMINAL_CONTENT_MAX;
  for (const s of sections) {
    if (left <= 0) break;
    out.push(inert(s, left));
    left -= sectionChars(s);
  }
  return out;
}

function notesOf(ask: Reported, complete: boolean, options: readonly PermissionOption[], words: Words): string[] {
  const notes: string[] = [];
  const total = Number(ask["question_count"]);
  const index = Number(ask["question_index"]);
  if (Number.isInteger(total) && total > 1 && Number.isInteger(index))
    notes.push(words.questionOf({ n: index + 1, of: total }));
  if (!complete) notes.push(words.tooLong);
  const rule = record(ask["input"])?.["always_allows"];
  if (complete && typeof rule === "string" && options.some((o) => o.kind === "allow_always"))
    notes.push(words.alwaysAllows({ rule: lit(rule, 200) }));
  notes.push(words.firstAnswerWins);
  return notes;
}

/** The card of a question a terminal asks. */
export function terminalAskView(input: TerminalAsk, lang: Lang = "en"): TerminalAskView {
  const words = terminalApprovalText.in(lang);
  const ask = input.ask;
  const raw = record(ask["input"]);
  const content = contentOf(str(ask["kind"]), str(ask["tool"]), raw, words);
  const complete =
    raw !== undefined && content.sections.reduce((n, s) => n + sectionChars(s), 0) <= TERMINAL_CONTENT_MAX;
  // Cut, never shown in part with a way to approve it: what was cut is what would run.
  const options = complete ? input.options : input.options.filter((o) => o.kind.startsWith("reject"));
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
    sections: shownSections(content.sections),
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
