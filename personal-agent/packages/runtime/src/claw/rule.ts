// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  ClawError,
  RULE_MAX_BYTES,
  RULE_TTL_MS,
  errorKind,
  pyStrip,
  type ClawCredential,
  type Clock,
  type Logger,
} from "@primusclaw/personal-agent";
import { segment, type ClawHttp, head } from "./http.js";
import { readZip } from "./zip.js";

/** A rule download is a zip of one file of at most RULE_MAX_BYTES; a larger answer is refused before it is held. */
export const RULE_DOWNLOAD_MAX_BYTES = 4 * RULE_MAX_BYTES;

/** The text of a rule tool as `GET /v1/tools/<id>/download` returns it: a zip holding one small markdown file. */
export function ruleText(download: Uint8Array): string {
  let entries;
  try {
    entries = readZip(download);
  } catch {
    throw new ClawAnswerInvalid("a rule download is not a zip");
  }
  const files = entries.filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith(".md"));
  const [file] = files;
  if (files.length !== 1 || file === undefined || file.size > RULE_MAX_BYTES) {
    throw new ClawAnswerInvalid("a rule download holds one small markdown file");
  }
  let text: string;
  try {
    text = pyStrip(new TextDecoder("utf-8", { fatal: true }).decode(file.read()));
  } catch {
    throw new ClawAnswerInvalid("a rule download that cannot be read");
  }
  if (text === "") throw new ClawAnswerInvalid("the rule is empty");
  return text;
}

/**
 * The reply-style rule: a public rule tool of Claw (CLAW_RULE_TOOL_ID), read with the caller's key and kept for
 * RULE_TTL_MS. When it cannot be read the last copy is used, else none: the person's message still goes.
 */
export class StyleRule {
  private copy: { text: string; at: number } | null = null;

  constructor(
    private readonly http: ClawHttp,
    private readonly toolId: number,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async text(key: ClawCredential): Promise<string> {
    const now = this.clock.monotonicMs();
    if (this.copy !== null && now - this.copy.at < RULE_TTL_MS) return this.copy.text;
    try {
      this.copy = { text: await this.download(key), at: now };
    } catch (err) {
      this.logger.warn("could not read the reply-style rule", {
        tool: this.toolId,
        error: errorKind(err),
        fallback: this.copy === null ? "the message goes without it" : "using the last copy",
      });
    }
    return this.copy?.text ?? "";
  }

  private async download(key: ClawCredential): Promise<string> {
    const path = `/v1/tools/${segment(this.toolId)}/download`;
    const { status, bytes } = await this.http.boundedBytes({ method: "GET", path, key }, RULE_DOWNLOAD_MAX_BYTES);
    if (status >= 400) throw new ClawError(status, head(new TextDecoder().decode(bytes)));
    return ruleText(bytes);
  }
}
