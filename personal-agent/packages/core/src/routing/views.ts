// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { AI_NOTICE } from "../locales/transparency.js";
import type { Lang } from "../locales/lang.js";
import { linkPage } from "../locales/link.js";
import { noteMessage, type NoteTone } from "../note/note.js";
import type { OutMessage, ViewButton } from "../ports/surface.js";
import type { NoteButton, NoteFactory } from "./features.js";

/**
 * The cards of connecting and of the chat's own commands (the Python `render.link_card`, `binding_request_card`,
 * `onboarding_card`, `repo_card`, `session_card`, `confirm_button`, `repo_button`, `show_button`), as view models the
 * channel renders (`teams/src/views/commands/`). A model carries what the card says, never card JSON.
 */

/** Connect by confirming as `who` on the platform, or on the console page with `/link CODE`. */
export interface LinkCardView {
  readonly bot: string;
  readonly who: string;
  /** The console page that gives a `/link` code. */
  readonly page: string;
  readonly notice: string;
}

/** A one-time link to open and confirm, and the button to press after. */
export interface BindingCardView {
  readonly bot: string;
  readonly confirmUrl: string;
  /** A first sentence ("" none). */
  readonly lead: string;
  readonly notice: string;
  /** The language of its title, body and buttons: the person's. */
  readonly lang: Lang;
}

/** A group member who has not connected: addressed to them, one button only they can use. */
export interface OnboardingCardView {
  readonly bot: string;
  readonly name: string;
  readonly channelUserId: string;
  readonly promptId: string;
  /** The steps are already in their 1:1 chat. */
  readonly dmSent: boolean;
  /** One extra line, for a card put back after someone else pressed its button ("" none). */
  readonly note: string;
  /** How long the request waits for them. */
  readonly waitMinutes: number;
}

/** One repository `/repo` lists. */
export interface RepoCardView {
  readonly repo: string;
  /** "" the default branch. */
  readonly branch: string;
  readonly lang: Lang;
}

/** One session `/sessions` lists. */
export interface SessionCardView {
  readonly sessionId: string;
  /** What it was started with ("" none known). */
  readonly title: string;
  readonly repo: string;
  readonly branch: string;
  /** When it was last used here, as the person reads it ("today 12:40"). */
  readonly when: string;
  /** It is this chat's session now. */
  readonly current: boolean;
  readonly lang: Lang;
  /** The console's address. */
  readonly publicBaseUrl: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    link: LinkCardView;
    binding: BindingCardView;
    onboarding: OnboardingCardView;
    repo: RepoCardView;
    session: SessionCardView;
  }
}

/** Minutes a group request waits for its asker to connect (the store keeps it as long). */
export const ONBOARDING_REQUEST_MINUTES = 15;

/** The Confirm button of the older connect card (the person says they confirmed). */
export const CONFIRM_BUTTON: NoteButton = {
  title: "Confirm",
  verb: "bind",
  data: { action: "confirm" },
  style: "positive",
};

/** The button a `/repo` card and its notes carry; it comes back from the client, so it is read again like typed text. */
export function repoButton(repo: string, branch: string, lang: Lang = "en"): NoteButton {
  return { title: lang === "zh" ? "用这个仓库" : "Use this repo", verb: "repo", data: { repo, branch } };
}

/** The Show here button: it makes a session this chat's session again. */
export function showButton(sessionId: string, title = "Show here"): NoteButton {
  return { title, verb: "show", data: { session_id: sessionId } };
}

function view(message: OutMessage["body"]): OutMessage {
  return { body: message };
}

/** A Create PR button, under the changes card and on the notes that put it back (Python `create_pr_button`). */
export function createPrButton(sessionId: string): NoteButton {
  return { title: "Create PR", verb: "create_pr", data: { session_id: sessionId } };
}

/**
 * A note button as the worker's click protocol carries it, field for field as the Python worker's `confirm_button`,
 * `repo_button`, `show_button` and `create_pr_button` build it: the verb `primusclaw.<kind>`, and the data naming the
 * kind first (`primusclaw: <kind>`), which is what a press is routed by.
 */
export function viewButtonOf(button: NoteButton): ViewButton {
  const built = {
    title: button.title,
    verb: `primusclaw.${button.verb}`,
    data: { primusclaw: button.verb, ...button.data },
  };
  return button.style ? { ...built, style: button.style } : built;
}

const TONES: ReadonlySet<string> = new Set<NoteTone>(["default", "good", "attention", "warning", "accent"]);

/**
 * The note card the router's clicks end as (Python `render.note_card(text, buttons, title, tone)`): what assembly passes
 * as `RouterDeps.note`. A tone the note does not know is the default one.
 */
export const noteFactory: NoteFactory = (text, options = {}) => {
  const tone = options.tone !== undefined && TONES.has(options.tone) ? (options.tone as NoteTone) : undefined;
  return noteMessage({
    text,
    ...(options.title ? { title: options.title } : {}),
    ...(tone ? { tone } : {}),
    ...(options.buttons?.length ? { buttons: options.buttons.map(viewButtonOf) } : {}),
  });
};

/** Builds the messages of the router's cards. */
export class CommandViews {
  constructor(
    private readonly bot: string,
    private readonly publicBaseUrl: string,
    readonly note: NoteFactory,
  ) {}

  /** The card that sends the person to the console's `/link` page of the channel `channel` (`SurfaceCaps.channel`). */
  link(who: string, channel: string): OutMessage {
    const model: LinkCardView = {
      bot: this.bot,
      who,
      page: linkPage(this.publicBaseUrl, channel),
      notice: AI_NOTICE.en,
    };
    return view({ type: "view", view: { name: "link", model }, fallbackText: `Connect ${this.bot}` });
  }

  /** The binding card in the person's language `lang` (its title, body, buttons and notice; `lead` is the caller's). */
  binding(confirmUrl: string, lead = "", lang: Lang = "en"): OutMessage {
    const model: BindingCardView = { bot: this.bot, confirmUrl, lead, notice: AI_NOTICE[lang], lang };
    const fallbackText = lang === "zh" ? `连接 ${this.bot}` : `Connect ${this.bot}`;
    return view({ type: "view", view: { name: "binding", model }, fallbackText });
  }

  onboarding(
    member: { name: string; channelUserId: string },
    promptId: string,
    dmSent: boolean,
    note = "",
  ): OutMessage {
    const model: OnboardingCardView = {
      bot: this.bot,
      name: member.name,
      channelUserId: member.channelUserId,
      promptId,
      dmSent,
      note,
      waitMinutes: ONBOARDING_REQUEST_MINUTES,
    };
    return view({ type: "view", view: { name: "onboarding", model }, fallbackText: `Connect ${this.bot}` });
  }

  repo(repo: string, branch: string, lang: Lang): OutMessage {
    return view({ type: "view", view: { name: "repo", model: { repo, branch, lang } }, fallbackText: repo });
  }

  session(card: Omit<SessionCardView, "publicBaseUrl">): OutMessage {
    const model: SessionCardView = { ...card, publicBaseUrl: this.publicBaseUrl };
    return view({ type: "view", view: { name: "session", model }, fallbackText: card.title || card.sessionId });
  }
}
