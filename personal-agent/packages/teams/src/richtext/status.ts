// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Status colour and headings: a line that starts with a status emoji gets that status's colour on its short label, and
 * a bold line becomes a larger bold heading whose colour follows its leading emoji.
 */
import { cpLength, own } from "@primusclaw/personal-agent";
import { MAX_LABEL_CHARS, STATUS_COLORS } from "./constants.js";
import { escaping, S } from "./escape.js";
import { inlineFrags, joinHtml, textFrag, type Frag } from "./inline.js";

const MARKER = new RegExp(`^${S}*(✅|❌|⏳|⚠\\ufe0f?)`, "u");
const LABEL_END = new RegExp(
  `：|:(?:${S}|$)|[，。；！？]|[,;](?:${S}|$)|${S}[—–-]+${S}|—+|\\.(?:${S}|$)|[!?](?:${S}|$)`,
  "u",
);

function colorOf(plain: string): string | null {
  const m = MARKER.exec(plain);
  return m?.[1] ? (own(STATUS_COLORS, m[1].charAt(0)) ?? null) : null;
}

function paint(color: string, inner: string): string {
  return `<span style="color:${color}">${inner}</span>`;
}

/** The colour a line's first fragment asks for, when it is text or bold. */
function leadingColor(frags: readonly Frag[]): string | null {
  const first = frags[0];
  return first && (first.kind === "text" || first.kind === "bold") ? colorOf(first.plain) : null;
}

/** The label (up to the first separator) and the rest; the label's length in code points. */
function splitLabel(items: readonly Frag[]): [Frag[], Frag[], number] {
  const label: Frag[] = [];
  let size = 0;
  for (const [index, item] of items.entries()) {
    const m = item.kind === "text" ? LABEL_END.exec(item.plain) : null;
    if (m) {
      if (m.index) {
        const head = item.plain.slice(0, m.index);
        label.push(textFrag(head));
        size += cpLength(head);
      }
      return [label, [textFrag(item.plain.slice(m.index)), ...items.slice(index + 1)], size];
    }
    label.push(item);
    size += cpLength(item.plain);
  }
  return [label, [], size];
}

/**
 * A line's html. A line that starts with a status emoji gets the colour on its short label only: the bold text after
 * the emoji, or else the words up to the first colon, comma, dash or full stop (at most MAX_LABEL_CHARS). A long line
 * with no such label stays uncoloured.
 */
export function statusLine(frags: readonly Frag[]): string {
  const whole = joinHtml(frags);
  const first = frags[0];
  const color = leadingColor(frags);
  if (!first || !color) return whole;
  if (first.kind === "bold") return paint(color, first.html) + joinHtml(frags.slice(1)); // **✅ Done** ...
  const markerEnd = MARKER.exec(first.plain)?.[0].length ?? 0;
  const tail = first.plain.slice(markerEnd);
  const after = tail.replace(new RegExp(`^${S}+`, "u"), "");
  const head = first.plain.slice(0, markerEnd) + tail.slice(0, tail.length - after.length); // the emoji and the space after it
  const items = [...(after ? [textFrag(after)] : []), ...frags.slice(1)];
  const lead = items[0];
  if (!after && lead?.kind === "bold") {
    return escaping.esc(head) + paint(color, lead.html) + joinHtml(items.slice(1)); // ✅ **label** rest
  }
  const [label, rest, size] = splitLabel(items);
  if (!label.length || size > MAX_LABEL_CHARS) return whole;
  return escaping.esc(head) + paint(color, joinHtml(label)) + joinHtml(rest);
}

/** One bold line as a larger bold heading; its colour follows a leading status emoji. */
export function heading(inner: string, px: number): string {
  const frags = inlineFrags(inner);
  const color = leadingColor(frags);
  const body = color ? paint(color, joinHtml(frags)) : joinHtml(frags);
  return `<b><span style="font-size:${String(px)}px">${body}</span></b>`;
}
