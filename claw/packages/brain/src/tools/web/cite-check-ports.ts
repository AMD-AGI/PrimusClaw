// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The network and the model a run's citation check uses (`tools/cite-check.ts`): pages read with the run's own `web_fetch`, so the
 * check opens nothing that tool would not (its address guards, its denylist, its cache), and the judge asked on the model that
 * summarizes fetched pages.
 */
import { WEB_FETCH_SUMMARIZE_MODEL } from "../../config.js";
import { judgePrompt, parseVerdicts, type CheckedPage, type CiteCheckPorts } from "../cite-check.js";
import type { WebFetchService } from "./fetch.js";
import type { WebToolContext, WebToolOutcome } from "./types.js";

/** The most parts of one page read (each `WEB_FETCH_MAX_OUTPUT_CHARS`): a long page's support may be past its first part. */
export const CITE_CHECK_PAGE_PARTS = 3;

/** The body of a `web_fetch` answer, without its header. */
function bodyOf(answer: string): string {
  const at = answer.indexOf("\n---\n");
  return at >= 0 ? answer.slice(at + 5) : answer;
}

/** The page at `url` as `web_fetch` reads it: one redirect to another host followed, up to `CITE_CHECK_PAGE_PARTS` parts. */
export async function readCitedPage(fetch: WebFetchService, url: string): Promise<CheckedPage> {
  let at = url;
  let parts: string[] = [];
  for (let hop = 0; hop < 2; hop++) {
    parts = [];
    let offset = 0;
    let redirected = false;
    for (let part = 0; part < CITE_CHECK_PAGE_PARTS; part++) {
      const outcome: WebToolOutcome = { isError: false };
      const answer = await fetch.execute(offset ? { url: at, offset } : { url: at }, outcome);
      if (outcome.isError || answer.startsWith("Error:")) return { ok: false };
      if (answer.startsWith("REDIRECT DETECTED")) {
        const next = answer.match(/^Redirected URL: (\S+)$/m)?.[1];
        if (!next || part > 0) return { ok: false };
        at = next;
        redirected = true;
        break;
      }
      parts.push(bodyOf(answer));
      // Read on only when the header says there is more: the page's own text never decides where the next read starts.
      const header = answer.slice(0, Math.max(0, answer.indexOf("\n---\n")));
      const more = header.match(/Call web_fetch again with offset=(\d+)/);
      if (!more) break;
      offset = Number(more[1]);
    }
    if (!redirected) break;
  }
  const text = parts.join("\n");
  return text.trim() ? { ok: true, text } : { ok: false };
}

/** The check's ports for a run with web fetch on: null when it has none (`parseCiteCheck` then fails every page). */
export function webCiteCheckPorts(fetch: WebFetchService | undefined, ctx: WebToolContext | undefined): CiteCheckPorts | null {
  if (!fetch || !ctx) return null;
  return {
    fetchPage: (url) => readCitedPage(fetch, url),
    judge: async ({ url, page, claims }, signal) => {
      const { system, user } = judgePrompt(url, page, claims);
      const resp = await ctx.anthropic.messages.create(
        { model: WEB_FETCH_SUMMARIZE_MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: user }] },
        { signal },
      );
      const usage = resp.usage as unknown as Record<string, number>;
      ctx.sessionCost.addUsage({
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read: usage.cache_read_input_tokens ?? 0,
        cache_create: usage.cache_creation_input_tokens ?? 0,
      });
      const text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      return parseVerdicts(text, claims.length);
    },
  };
}
