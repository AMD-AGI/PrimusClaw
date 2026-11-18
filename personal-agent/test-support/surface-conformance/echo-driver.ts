// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The echo surface's driver for the conformance kit: its events posted to its webhook, its records read back. */
import type { SurfaceCaps } from "@primusclaw/personal-agent";

import {
  buildEchoWorker,
  EVENTS_PATH,
  ECHO_CAPS,
  type EchoButton,
  type EchoEvent,
  type EchoRecord,
  type EchoSurface,
} from "../echo-surface/index.js";
import type { ChatDriver, KitChat, KitPerson, SeenMessage, SurfaceUnderTest } from "./driver.js";

function seenOf(record: EchoRecord): SeenMessage | undefined {
  if (record.op === "typing" || record.op === "delete") return undefined;
  const base = { chat: record.chat, id: record.id };
  if (record.op === "stream" && !record.final) {
    return { ...base, op: "stream", final: false, text: record.text, buttons: [], choices: [], mentions: [] };
  }
  const { message } = record;
  return {
    ...base,
    op: record.op === "edit" ? "edit" : record.op,
    final: true,
    text: message.text,
    buttons: message.buttons.map((b) => ("url" in b ? { title: b.title, url: b.url } : { title: b.title })),
    choices: message.choices?.options.map((o) => o.title) ?? [],
    mentions: message.mentions,
  };
}

class EchoDriver implements ChatDriver {
  readonly env = {};
  private surface: EchoSurface | undefined;
  private base = "";
  private n = 0;

  constructor(readonly caps: SurfaceCaps) {}

  readonly buildWorker: ChatDriver["buildWorker"] = (env, plugins, options) =>
    buildEchoWorker(env, plugins, {
      ...options,
      caps: this.caps,
      opened: (surface) => {
        this.surface = surface;
      },
    });

  attach(baseUrl: string): void {
    this.base = baseUrl;
  }

  private async post(event: EchoEvent): Promise<void> {
    const answer = await fetch(this.base + EVENTS_PATH, { method: "POST", body: JSON.stringify(event) });
    if (answer.status !== 200)
      throw new Error(`the echo webhook answered ${String(answer.status)}: ${await answer.text()}`);
  }

  private nextId(): string {
    this.n += 1;
    return `in-${String(this.n)}`;
  }

  say(chat: KitChat, from: KitPerson, text: string, options: { mentionsBot?: boolean } = {}): Promise<void> {
    const mentionsBot = options.mentionsBot === true;
    return this.post({ type: "message", id: this.nextId(), chat, from, text, mentionsBot });
  }

  async press(chat: KitChat, from: KitPerson, message: SeenMessage, button: string, picked: readonly string[] = []) {
    const record = this.surface?.records.find(
      (r) =>
        r.op !== "typing" &&
        r.op !== "delete" &&
        "message" in r &&
        r.id === message.id &&
        r.message.text === message.text,
    );
    const shown = record !== undefined && "message" in record ? record.message : undefined;
    const pressed = shown?.buttons.find(
      (b): b is Extract<EchoButton, { data: unknown }> => b.title === button && "data" in b,
    );
    if (shown === undefined || pressed === undefined) throw new Error(`no button "${button}" on message ${message.id}`);
    const choices = shown.choices;
    const values = picked.map((title) => choices?.options.find((o) => o.title === title)?.value ?? "missing");
    const inputs = choices === undefined || picked.length === 0 ? undefined : { [choices.id]: values.join(",") };
    await this.post({
      type: "press",
      id: this.nextId(),
      chat,
      from,
      messageId: message.id,
      data: pressed.data,
      ...(inputs ? { inputs } : {}),
    });
  }

  seen(chat?: KitChat): readonly SeenMessage[] {
    return (this.surface?.records ?? []).flatMap((r) => {
      const seen = chat === undefined || r.chat === chat.id ? seenOf(r) : undefined;
      return seen === undefined ? [] : [seen];
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The echo surface under the kit, with `caps` (default: everything but citations and suggestions). */
export function echoUnderTest(name: string, caps: SurfaceCaps = ECHO_CAPS): SurfaceUnderTest {
  return { name, open: () => Promise.resolve(new EchoDriver(caps)) };
}
