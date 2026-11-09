// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn's cards in Teams (render.py's delivery_card and changes_card): a file the agent delivered, and what the
 * session changed under a finished answer.
 */
import { turn } from "@primusclaw/personal-agent";

import { buttons, execute, header, message, note, openUrl, text, TITLE_MAX } from "../../cards/kit.js";
import type { CardElement } from "../../cards/json.js";
import type { Renderers } from "../registry.js";
import { noteCard } from "./note.js";
import { stopCard } from "./stop.js";

/** Files listed on the changes card, over all repositories; the rest is one "+N more" line. */
export const CHANGES_MAX_FILES = 8;
/** A phone line holds about 45 characters; a longer path keeps its end ("…/dir/file.py"). */
export const CHANGES_PATH_MAX = 60;

/** A 1:1 chat's card for a delivered file: its name, size and caption, the image when one came along, and Download. */
export function deliveryCard(model: turn.DeliveryModel): ReturnType<typeof message> {
  const { delivery, url } = model;
  const body: CardElement[] = [
    header(turn.plain(delivery.name), { subtitle: turn.sizeText(delivery.size), emoji: "file" }),
  ];
  if (delivery.caption) body.push(text(turn.plain(delivery.caption)));
  if (delivery.image) body.push({ type: "Image", url: delivery.image, altText: delivery.name });
  return message(body, buttons([openUrl("Download", url)]));
}

function fileLine(change: turn.FileChange): string {
  const points = Array.from(change.path);
  const path = points.length <= CHANGES_PATH_MAX ? change.path : `…${points.slice(-(CHANGES_PATH_MAX - 1)).join("")}`;
  let counts = "";
  if (change.binary) counts = " (binary)";
  else if (change.additions !== undefined || change.deletions !== undefined) {
    counts = ` +${String(change.additions ?? 0)} -${String(change.deletions ?? 0)}`;
  }
  return `${change.status} ${turn.plain(path)}${counts}`;
}

/** What the card's button carries; the session is read back from the click and checked against the chat's own. */
export function createPrButton(sessionId: string, title = "Create PR"): CardElement {
  return execute(title, "primusclaw.create_pr", { primusclaw: "create_pr", session_id: sessionId });
}

/** The repositories' lines, at most CHANGES_MAX_FILES files over all of them. */
function repoLines(changes: turn.Changes): { readonly lines: CardElement[]; readonly shown: number } {
  const lines: CardElement[] = [];
  let shown = 0;
  for (const repo of changes.repos) {
    const room = CHANGES_MAX_FILES - shown;
    if (room <= 0) break;
    const label = [turn.repoName(repo), repo.branch ?? "", repo.head].filter((part) => part).join(" · ");
    if (changes.repos.length > 1 || repo.branch || repo.head) {
      lines.push(text(turn.plain(turn.clip(label, TITLE_MAX)), { weight: "Bolder", size: "Small" }));
    }
    for (const change of repo.files.slice(0, room)) {
      lines.push(text(fileLine(change), { size: "Small", spacing: "None", mono: true }));
      shown += 1;
    }
  }
  return { lines, shown };
}

/** An absolute https URL for a Claw-relative link; undefined for anything else (never an arbitrary URL). */
function openLink(link: string, publicBaseUrl: string): string | undefined {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return link.startsWith("/") && !link.startsWith("//") && base.startsWith("https://") ? base + link : undefined;
}

/**
 * The card under a finished answer: how many files the session changed and the lines added and removed, up to
 * CHANGES_MAX_FILES of them one line each, "+N more" for the rest, and Create PR and Open diff in Claw.
 */
export function changesCard(model: turn.ChangesModel): ReturnType<typeof message> {
  const { changes, sessionId, publicBaseUrl } = model;
  const count = turn.totalFiles(changes);
  // Claw cut the list: the count is "at least"
  const lowerBound = changes.repos.some((r) => r.truncated && r.totalFiles <= r.files.length) ? "+" : "";
  const summary = `${String(count)}${lowerBound} file${count !== 1 ? "s" : ""} changed, +${String(turn.totalAdditions(changes))} -${String(turn.totalDeletions(changes))}`;
  const { lines, shown } = repoLines(changes);
  const body = [header("Changes", { tone: "accent", subtitle: summary, emoji: "changes" }), ...lines];
  if (count > shown) body.push(note(`+${String(count - shown)}${lowerBound} more`));
  const diff = openLink(`/primus-claw/${sessionId}`, publicBaseUrl);
  return message(body, buttons([createPrButton(sessionId), diff ? openUrl("Open diff in Claw", diff) : null]));
}

export const TURN_RENDERERS = {
  delivery: deliveryCard,
  changes: changesCard,
  note: noteCard,
  turnStop: stopCard,
} satisfies Partial<Renderers>;
