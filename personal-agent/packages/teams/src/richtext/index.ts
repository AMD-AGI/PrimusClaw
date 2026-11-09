// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The agent's markdown answer as the small HTML subset Teams renders in a bot message with textFormat "xml".
 *
 * Measured on Teams desktop (dark theme) and iPhone: <b> <i> <u> <s>, <br>, <span style="color:..."> and
 * <span style="font-size:..px"> render; <h2> renders only as bold; <font> is ignored. <a>, <code> and <pre> are the
 * ordinary HTML for links and code and degrade to their text where a client ignores them. Lists are drawn as lines
 * with a bullet character and <br>, which needs no list tags.
 *
 * The answer is untrusted text. Nothing from it reaches the output except escaped (text and code) or through
 * `safeUrl` (an http/https URL that goes into an attribute after attribute escaping). `checkHtml` then re-reads the
 * finished HTML against an allow-list, so a bug fails closed: `toTeamsHtml` throws and `richTextActivity` sends the
 * original markdown instead.
 */
import { silentLogger, type Logger } from "@primusclaw/personal-agent";
import type { JsonObject } from "../cards/json.js";
import { toTeamsHtml } from "./blocks.js";

export { toTeamsHtml } from "./blocks.js";
export { checkHtml } from "./check.js";
export {
  LABEL_PX,
  LEAD_PX,
  MAX_INPUT_CHARS,
  MAX_LABEL_CHARS,
  MAX_NEST,
  MAX_OUTPUT_BYTES,
  MAX_URL_CHARS,
  RichTextError,
  STATUS_COLORS,
} from "./constants.js";
export { unescapeMarkdown } from "./escape.js";
export { safeUrl } from "./url.js";

/** The markdown as it is (Python's `text_activity`): what is sent when the rich conversion cannot be. */
export function markdownActivity(markdown: string): JsonObject {
  return { type: "message", text: markdown, textFormat: "markdown" };
}

/**
 * A final answer as an xml-format message (bold labels, colour on status lines, links, code). Anything that goes
 * wrong in the conversion sends the markdown unchanged: the user always gets the answer. Only the error's kind is
 * logged, never the text.
 */
export function richTextActivity(
  markdown: string,
  options: { readonly lead?: boolean } = {},
  logger: Logger = silentLogger,
): JsonObject {
  try {
    return { type: "message", text: toTeamsHtml(markdown, options), textFormat: "xml" };
  } catch (err) {
    logger.warn("rich answer conversion failed; sending the markdown", {
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return markdownActivity(markdown);
  }
}
