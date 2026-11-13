// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A model's reading of a request, held to what the message really says. The reading decides only what to do, never who
 * may be acted as: every pull request is one the message names, the reviewer is a mention of the message or a name it
 * writes, and a model is one it writes.
 */

import { pyFullmatch } from "../text/py-regex.js";
import { reviewRequestText } from "../locales/review-request.js";
import { decimalInt, pyStrip, squashSpaces } from "../text/py-text.js";
import { type BareGroup, bareGroups } from "../review-text/bare-numbers.js";
import { displayName, type Mention, mentionId, personOf, writtenIn } from "../review-text/names.js";
import { MARK_CLOSE, MARK_OPEN, pullKey, pullsIn, keyParts, type PullKey } from "../review-text/pull-ref.js";
import type { PullRef } from "../claw/model.js";
import { MODEL_ID } from "../review-text/asks.js";
import { type ReviewAsk, reviewAsk } from "./request-parse.js";
import { wordHashNumbers } from "../review-text/text/scan.js";
import { casefold, flat, unique } from "../review-text/text/unicode.js";

const BARE_NUMBER = pyFullmatch(String.raw`#?\s*\d{1,7}`);

export const INTENTS = ["review_merge", "review", "none"] as const;

/** What the reading comes to. */
export type IntentVerdict =
  /** Not a request to review: chat, as ever. */
  | { readonly kind: "chat" }
  /** The one question to ask back. */
  | { readonly kind: "question"; readonly text: string }
  | { readonly kind: "ask"; readonly ask: ReviewAsk }
  /** The answer is no reading at all (not JSON, an unknown intent, a field of the wrong type): the rules read it. */
  | { readonly kind: "unreadable"; readonly why: string };

interface Reading {
  readonly intent: (typeof INTENTS)[number];
  readonly reviewer: string;
  readonly everyone: readonly unknown[];
  readonly prs: readonly unknown[];
  readonly model: string;
}

/** Python's truthiness, for a field a model may give as null, "", 0, false or []. */
function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return value !== null && Object.keys(value).length > 0;
  return Boolean(value);
}

function readingOf(raw: Readonly<Record<string, unknown>>): Reading | string {
  const intent = raw.intent;
  // (not the value: it is the model's text, which can quote the message)
  if (!INTENTS.includes(intent as Reading["intent"])) return "unknown intent";
  const reviewer = present(raw.reviewer) ? raw.reviewer : "";
  const prs = present(raw.prs) ? raw.prs : [];
  const model = present(raw.model) ? raw.model : "";
  const everyone = raw.reviewers !== undefined && raw.reviewers !== null ? raw.reviewers : [reviewer];
  if (typeof reviewer !== "string" || !Array.isArray(prs) || typeof model !== "string" || !Array.isArray(everyone)) {
    return "field types";
  }
  return { intent: intent as Reading["intent"], reviewer, everyone, prs, model };
}

const named = (values: readonly unknown[]): string[] =>
  values.filter((r): r is string => typeof r === "string" && pyStrip(r) !== "");

/**
 * Which of the message's pull requests (`keys`) one entry of the model's "prs" is: a link or owner/repo#N, or a number as
 * the asker wrote it ("245", "#245", "PR 245", "PrimusClaw#245") when exactly one of them has that number (and that
 * repository, when one is written).
 */
export function pullsWritten(item: string, keys: ReadonlySet<PullKey>): Set<PullKey> {
  const refs = pullsIn(item);
  if (refs.length) return new Set(refs.map(pullKey).filter((k) => keys.has(k)));
  let groups: BareGroup[];
  if (BARE_NUMBER.test(item)) {
    groups = [{ spans: [[0, 0]], numbers: [decimalInt(pyStrip(item.replace(/^#+/u, "")))], repo: "", explicit: true }];
  } else {
    groups = bareGroups(item);
    if (!groups.length) {
      groups = wordHashNumbers(item).map(([repo, digits]) => ({
        spans: [[0, 0]],
        numbers: [decimalInt(digits)],
        repo,
        explicit: true,
      }));
    }
  }
  const found = new Set<PullKey>();
  for (const group of groups) {
    const repo = group.repo.toLowerCase().replace(/\.git$/u, "");
    for (const number of group.numbers) {
      const hits = [...keys].filter((k) => {
        const [owner, name, n] = keyParts(k);
        return n === number && (!repo || repo === name || repo === `${owner}/${name}`);
      });
      if (hits.length === 1 && hits[0] !== undefined) found.add(hits[0]);
    }
  }
  return found;
}

/** The mentions a reviewer the model wrote is: by id, or by display name when that is exactly one person. */
function mentionRefs(reviewer: string, mentions: readonly Mention[]): number[] {
  const byId = mentions.flatMap((m, i) => (reviewer && mentionId(m) === reviewer ? [i] : []));
  if (byId.length || !reviewer) return byId;
  const byName = mentions.flatMap((m, i) => (flat(m.name) === flat(reviewer) ? [i] : []));
  return new Set(byName.map((i) => mentionId(mentions[i] as Mention))).size === 1 ? byName : [];
}

function whoOf(
  reading: Reading,
  text: string,
  mentions: readonly Mention[],
  people: readonly string[],
  direct: boolean,
  bot: string,
): { readonly who: string } | { readonly question: string } {
  const reviewer = squashSpaces(reading.reviewer);
  const refs = mentionRefs(reviewer, mentions);
  if (refs.length) return { who: refs.map((i) => `${MARK_OPEN}${String(i)}${MARK_CLOSE}`).join("") };
  if (reviewer && flat(reviewer) && !reviewer.includes(MARK_OPEN) && writtenIn(reviewer, text))
    return { who: reviewer };
  if (reviewer) return { question: reviewRequestText.nameNotInMessage({ name: displayName(reviewer), bot }) };
  // (a 1:1 chat that names nobody: the asker reviews with their own account; no reviewer, yet someone asked: a question)
  if (direct) return people.length ? { question: reviewRequestText.unsureWho(bot) } : { who: "" };
  return { question: reviewRequestText.askWho(bot) };
}

/**
 * The model's reading of a request, held to the message. `text` is what the asker wrote (with the addresses behind its
 * links), never a message it quotes: a quote may name the pull requests (`found` is read from it too), never the reviewer
 * or the model. `direct`: a 1:1 chat, where naming nobody means the asker. `bot`: the bot's name in this deployment, for the
 * example a question shows.
 */
export function checkIntent(
  raw: Readonly<Record<string, unknown>>,
  text: string,
  mentions: readonly Mention[],
  found: readonly PullRef[],
  direct: boolean,
  bot: string,
): IntentVerdict {
  const reading = readingOf(raw);
  if (typeof reading === "string") return { kind: "unreadable", why: reading };
  if (reading.intent === "none") return { kind: "chat" };
  // (a review only, with nobody named: chat, as before)
  if (reading.intent === "review" && !pyStrip(reading.reviewer) && !named(reading.everyone).length)
    return { kind: "chat" };
  // One request is one reviewer: a reading that gives every pull request to one person of several must not act as that
  // person on the others' pull requests.
  const asked = named(reading.everyone);
  const people = unique(asked.map((r) => personOf(r, mentions)));
  if (people.length > 1) {
    return {
      kind: "question",
      text: reviewRequestText.onePersonPerMessage({ names: unique(asked.map(displayName)).join("、") }),
    };
  }
  const keys = new Set(found.map(pullKey));
  const chosen = new Set(named(reading.prs).flatMap((item) => [...pullsWritten(pyStrip(item), keys)]));
  const pulls = found.filter((p) => chosen.has(pullKey(p)));
  const who = whoOf(reading, text, mentions, people, direct, bot);
  if ("question" in who) return { kind: "question", text: who.question };
  if (!pulls.length) return { kind: "question", text: reviewRequestText.noPullRecognised(bot) };
  const model = pyStrip(reading.model);
  if (model && (!new RegExp(`^(?:${MODEL_ID})$`, "u").test(model) || !casefold(text).includes(casefold(model)))) {
    return { kind: "question", text: reviewRequestText.unsureModel };
  }
  return {
    kind: "ask",
    ask: reviewAsk({
      who: who.who,
      mentions,
      pulls,
      models: model ? [model] : [],
      merge: reading.intent === "review_merge",
    }),
  };
}
