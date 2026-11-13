// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One small model call that says what a message asks for, made with the asker's own key on the platform's LLM gateway
 * (OpenAI-compatible `chat/completions`). What it answers decides only what to do, and only after the domain holds it to
 * the message; it widens no permission. undefined for anything but an answer in time: the rules read the message instead.
 */

import {
  answerPrompt,
  intentPrompt,
  modePrompt,
  type IntentReader,
  type ListedMention,
  type Logger,
  errorName,
  pyJsonDumps,
  pyRstrip,
} from "@primusclaw/personal-agent";
import { z } from "zod";

import type { FetchLike } from "./api.js";

/** Past this the rules read the request instead. */
export const INTENT_MS = 10_000;

const completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.unknown() }).loose() }).loose()).min(1),
});

export interface IntentReaderOptions {
  readonly baseUrl: string;
  readonly model: string;
  /** The bot's name in this deployment (`Settings.botName`): the prompts say who the message was sent to. */
  readonly botName: string;
  readonly logger: Logger;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/** The JSON object in what the model wrote; `{ intent: null }` when there is none. */
export function readingOf(content: unknown): Record<string, unknown> {
  const text = typeof content === "string" ? content : "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { intent: null };
  try {
    const out: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof out === "object" && out !== null && !Array.isArray(out)
      ? (out as Record<string, unknown>)
      : { intent: null };
  } catch {
    return { intent: null };
  }
}

export class GatewayIntentReader implements IntentReader {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: IntentReaderOptions) {
    this.url = `${pyRstrip(options.baseUrl, "/")}/chat/completions`;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  read(
    key: string,
    text: string,
    mentions: readonly ListedMention[],
    channel: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.complete(key, intentPrompt(channel, this.options.botName), { message: text, mentions });
  }

  readMode(key: string, text: string, channel: string): Promise<Record<string, unknown> | undefined> {
    return this.complete(key, modePrompt(channel, this.options.botName), { message: text });
  }

  readAnswer(
    key: string,
    text: string,
    pending: readonly Readonly<Record<string, string>>[],
    channel: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.complete(key, answerPrompt(channel, this.options.botName), {
      message: text,
      waiting_for_this_person: pending,
    });
  }

  private async complete(key: string, system: string, payload: unknown): Promise<Record<string, unknown> | undefined> {
    const body = {
      model: this.options.model,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: system },
        { role: "user", content: pyJsonDumps(payload) },
      ],
    };
    let content: unknown;
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? INTENT_MS),
      });
      if (response.status !== 200) {
        this.options.logger.info("the request could not be read by the model; the rules read it", {
          status: response.status,
        });
        return undefined;
      }
      const parsed = completion.safeParse(await response.json());
      if (!parsed.success) throw new TypeError("not a completion");
      content = parsed.data.choices[0]?.message.content;
    } catch (error) {
      this.options.logger.info("the request could not be read by the model; the rules read it", {
        error: errorName(error),
      });
      return undefined;
    }
    return readingOf(content);
  }
}
