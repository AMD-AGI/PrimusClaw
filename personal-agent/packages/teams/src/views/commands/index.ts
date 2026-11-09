// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How Teams shows the cards of connecting and of the chat's own commands: single column, Action.Execute (and an open-link
 * button) only, so they render the same on desktop and on the phone. Byte for byte the Python worker's `render.link_card`,
 * `binding_request_card`, `onboarding_card`, `repo_card` and `session_card` (snapshots `link`, `binding`, `onboarding`,
 * `repo`, `session`).
 */
import type {
  BindingCardView,
  LinkCardView,
  OnboardingCardView,
  RepoCardView,
  SessionCardView,
} from "@primusclaw/personal-agent";

import { clip } from "../../cards/cjk.js";
import type { CardElement } from "../../cards/json.js";
import {
  buttons,
  execute,
  facts,
  header,
  message,
  note,
  openUrl,
  text,
  TITLE_MAX,
  type CardMessage,
} from "../../cards/kit.js";
import type { Renderers } from "../registry.js";

/** The older connect card's Confirm button (the person says they confirmed). */
export function confirmButton(): CardElement {
  return { ...execute("Confirm", "primusclaw.bind", { primusclaw: "bind", action: "confirm" }), style: "positive" };
}

export function linkCard(model: LinkCardView): CardMessage {
  return message(
    [
      header(`Connect ${model.bot}`, {
        tone: "accent",
        subtitle: `Act as ${model.who} on the Primus platform`,
        emoji: "connect",
      }),
      text(
        "Tasks you send me run with your own permissions, using a token that lasts 10 minutes. " +
          "You can remove this in SaFE under identity bindings, or send /unlink.",
      ),
      note(`On a desktop you can also connect on the page below and send \`/link CODE\` here.\n\n${model.page}`),
      note(model.notice),
    ],
    [confirmButton()],
  );
}

export function bindingCard(model: BindingCardView): CardMessage {
  return message(
    [
      header(`Connect ${model.bot}`, { tone: "accent", subtitle: model.lead.trim(), emoji: "connect" }),
      text(
        "Open the link, sign in to your Primus account and confirm once. After that I work as you on " +
          "the Primus platform, with your own permissions.",
      ),
      note(
        "The link works once and runs out in 10 minutes. I use a token that lasts 5 minutes, never your " +
          "password. You can remove the connection in SaFE under identity bindings.",
      ),
      note(model.notice),
    ],
    buttons([
      openUrl("Open link", model.confirmUrl),
      execute("I confirmed", "primusclaw.bind", { primusclaw: "bind", action: "confirm" }),
    ]),
  );
}

/** A display name that is safe inside an <at> tag. */
function nameForMention(name: string): string {
  return Array.from(name.replace(/[<>&]/gu, " ").split(/\s+/u).filter(Boolean).join(" ")).slice(0, 60).join("");
}

export function onboardingCard(model: OnboardingCardView): CardMessage {
  const who = nameForMention(model.name);
  const mention = Boolean(who && model.channelUserId);
  const first = mention
    ? `<at>${who}</at>, connect ${model.bot} once to use it here.`
    : `${who || "You"}, connect ${model.bot} once to use it here.`;
  const second =
    (model.dmSent
      ? "I sent you the steps in a 1:1 chat. "
      : `Press Connect ${model.bot} and I will send you the steps. `) +
    `Your request waits ${String(model.waitMinutes)} minutes, and I run it here as soon as you are connected.`;
  const body = [header(first, { tone: "accent", emoji: "connect" }), text(second)];
  if (model.note) body.push(note(model.note));
  const actions = buttons([
    execute(`Connect ${model.bot}`, "primusclaw.onboard", { primusclaw: "onboard", prompt: model.promptId }),
  ]);
  if (!mention) return message(body, actions);
  const entities = [{ type: "mention", text: `<at>${who}</at>`, mentioned: { id: model.channelUserId, name: who } }];
  return message(body, actions, undefined, { msteams: { entities } });
}

/** What a `/repo` card's button carries; it comes back from the client, so the worker reads it again like typed text. */
export function repoButton(repo: string, branch: string, lang: string, title = "Use this repo"): CardElement {
  const shown = lang === "zh" && title === "Use this repo" ? "用这个仓库" : title;
  return execute(shown, "primusclaw.repo", { primusclaw: "repo", repo, branch });
}

export function repoCard(model: RepoCardView): CardMessage {
  const zh = model.lang === "zh";
  const line = model.branch
    ? `${zh ? "分支：" : "Branch: "}${clip(model.branch, TITLE_MAX)}`
    : zh
      ? "默认分支"
      : "Default branch";
  return message(
    [header(clip(model.repo, TITLE_MAX), { subtitle: line, emoji: "repo" })],
    buttons([repoButton(model.repo, model.branch, model.lang)]),
  );
}

export function showButton(sessionId: string, title = "Show here"): CardElement {
  return execute(title, "primusclaw.show", { primusclaw: "show", session_id: sessionId });
}

/** An absolute https URL for a Claw-relative link; undefined for anything else (never an arbitrary URL). */
function openLink(link: string, publicBaseUrl: string): string | undefined {
  const base = publicBaseUrl.replace(/\/+$/u, "");
  if (!link.startsWith("/") || link.startsWith("//") || !base.startsWith("https://")) return undefined;
  return base + link;
}

export function sessionCard(model: SessionCardView): CardMessage {
  const zh = model.lang === "zh";
  const shortId = model.sessionId.slice(0, 8);
  const title = clip(model.title || (zh ? `会话 ${shortId}` : `Session ${shortId}`), TITLE_MAX);
  const sub = zh
    ? (model.current ? "当前会话 · " : "") + `上次使用：${model.when}`
    : (model.current ? "This chat's session now · " : "") + `Last used ${model.when}`;
  const body = [header(title, { tone: model.current ? "accent" : "default", subtitle: sub, emoji: "session" })];
  if (model.repo) {
    const where = model.branch ? `${model.repo}@${model.branch}` : model.repo;
    body.push(...facts([[zh ? "仓库" : "Repository", where]]));
  }
  const url = openLink(`/primus-claw/${model.sessionId}`, model.publicBaseUrl);
  return message(
    body,
    buttons([
      showButton(model.sessionId, zh ? "在这里显示" : "Show here"),
      url === undefined ? null : openUrl(zh ? "在 Claw 中打开" : "Open in Claw", url),
    ]),
  );
}

export const COMMAND_RENDERERS = {
  link: linkCard,
  binding: bindingCard,
  onboarding: onboardingCard,
  repo: repoCard,
  session: sessionCard,
} satisfies Partial<Renderers>;
