// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Teams surface's driver for the conformance kit: the worker in the release gate's test entry (direct mode, inbound
 * activities posted to `/gate/v1/activity` on the loopback, outbound to the recording Bot Connector), the kit's people and
 * chats as Teams activities, and what the connector recorded read back as the kit's `SeenMessage`s (a card's words,
 * buttons and choices, a stream's requests).
 */
import type { SurfaceCaps } from "@primusclaw/personal-agent";

import { RecordingConnector, streamInfo, type Record_ } from "../../../../test-support/recording-connector.js";
import type {
  ChatDriver,
  KitChat,
  KitPerson,
  SayOptions,
  SeenButton,
  SeenMessage,
  SurfaceUnderTest,
} from "../../../../test-support/surface-conformance/driver.js";
import { buildWorker } from "../../src/assembly/worker.js";
import { teamsCaps } from "../../src/caps.js";

type Json = Record<string, unknown>;

const BOT = { id: "28:bot", name: "PrimusClaw Assistant" };

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a card shows: its words (text blocks, rich text, facts), its buttons (with their data) and its pick list. */
interface CardShown {
  readonly words: string[];
  readonly actions: Json[];
  readonly choices: { readonly id: string; readonly options: { title: string; value: string }[] } | undefined;
}

type Shown = { words: string[]; actions: Json[]; choices: CardShown["choices"] };

/** What one card element shows itself (its children are walked apart). */
function element(node: Json, shown: Shown): void {
  const type = typeof node["type"] === "string" ? node["type"] : "";
  if (type.startsWith("Action.") && typeof node["title"] === "string") shown.actions.push(node);
  if ((type === "TextBlock" || type === "TextRun") && typeof node["text"] === "string") shown.words.push(node["text"]);
  if (type === "Fact") shown.words.push(`${String(node["title"])}: ${String(node["value"])}`);
  if (type === "Input.ChoiceSet" && typeof node["id"] === "string" && Array.isArray(node["choices"])) {
    const options = (node["choices"] as Json[]).map((c) => ({ title: String(c["title"]), value: String(c["value"]) }));
    shown.choices = { id: node["id"], options };
  }
}

function walk(node: unknown, shown: Shown): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, shown);
    return;
  }
  if (!isJson(node)) return;
  element(node, shown);
  for (const [key, value] of Object.entries(node)) if (key !== "data") walk(value, shown);
}

/** The cards an activity carries, as one. */
export function cardOf(activity: Json): CardShown {
  const shown: Shown = { words: [], actions: [], choices: undefined };
  const attachments = Array.isArray(activity["attachments"]) ? activity["attachments"] : [];
  for (const attachment of attachments) if (isJson(attachment)) walk(attachment["content"], shown);
  return shown;
}

function buttonOf(action: Json): SeenButton {
  const title = String(action["title"]);
  return action["type"] === "Action.OpenUrl" ? { title, url: String(action["url"]) } : { title };
}

function mentionsOf(activity: Json): string[] {
  const entities = Array.isArray(activity["entities"]) ? activity["entities"] : [];
  return entities.flatMap((e) => {
    if (!isJson(e) || e["type"] !== "mention" || !isJson(e["mentioned"])) return [];
    const id = String(e["mentioned"]["id"]);
    return [id.startsWith("29:") ? id.slice(3) : id];
  });
}

/** One record of the connector as the kit reads it; undefined for a typing indicator or a delete. */
export function seenOf(record: Record_): SeenMessage | undefined {
  const { activity } = record;
  const info = streamInfo(activity);
  if (record.op === "delete" || (activity["type"] === "typing" && info === undefined)) return undefined;
  const card = cardOf(activity);
  const text = [typeof activity["text"] === "string" ? activity["text"] : "", ...card.words].filter(Boolean).join("\n");
  const stream = info !== undefined;
  return {
    chat: record.conversation,
    id: (stream ? record.streamId : record.activityId) ?? "",
    op: stream ? "stream" : record.op === "update" ? "edit" : "post",
    final: !stream || info["streamType"] === "final",
    text,
    buttons: card.actions.map(buttonOf),
    choices: card.choices?.options.map((o) => o.title) ?? [],
    mentions: mentionsOf(activity),
  };
}

class TeamsDriver implements ChatDriver {
  readonly caps: SurfaceCaps = teamsCaps("direct");
  readonly buildWorker = buildWorker;
  readonly env: Readonly<Record<string, string>>;
  private gate = "";
  private n = 0;

  constructor(private readonly connector: RecordingConnector) {
    this.env = {
      OUTBOUND_MODE: "direct",
      BOT_MSI_CLIENT_ID: "conformance",
      TEAMS_GATE_ENTRY: "1",
      GATE_RUN_ID: "surface-conformance",
      TEAMS_GATE_CONNECTOR_URL: connector.url,
    };
  }

  attach(baseUrl: string): void {
    this.gate = `${baseUrl}/gate/v1/activity`;
  }

  private base(chat: KitChat, from: KitPerson): Json {
    this.n += 1;
    return {
      id: `act-${String(this.n)}`,
      serviceUrl: `${this.connector.url}/`,
      channelId: "msteams",
      from: { id: `29:${from.id}`, aadObjectId: from.id, name: from.name },
      recipient: BOT,
      conversation: {
        id: chat.id,
        conversationType: chat.kind === "personal" ? "personal" : "groupChat",
        tenantId: "conformance-tenant",
      },
      locale: "en-US",
    };
  }

  private async post(activity: Json): Promise<void> {
    const answer = await fetch(this.gate, { method: "POST", body: JSON.stringify(activity) });
    if (answer.status !== 200)
      throw new Error(`the test entry answered ${String(answer.status)}: ${await answer.text()}`);
  }

  say(chat: KitChat, from: KitPerson, text: string, options: SayOptions = {}): Promise<void> {
    const at = `<at>${BOT.name}</at>`;
    const mention = { type: "mention", mentioned: BOT, text: at };
    const mentioned = options.mentionsBot === true;
    return this.post({
      ...this.base(chat, from),
      type: "message",
      text: mentioned ? `${at} ${text}` : text,
      ...(mentioned ? { entities: [mention] } : {}),
    });
  }

  /** The press Teams sends for an Action.Execute (desktop, web and mobile): an invoke whose data carries the card's inputs. */
  async press(chat: KitChat, from: KitPerson, message: SeenMessage, button: string, picked: readonly string[] = []) {
    const record = this.connector.recorder.records.find((r) => {
      const seen = seenOf(r);
      return seen !== undefined && seen.id === message.id && seen.text === message.text;
    });
    if (record === undefined) throw new Error(`no message ${message.id} was recorded`);
    const card = cardOf(record.activity);
    const action = card.actions.find((a) => a["title"] === button && a["type"] !== "Action.OpenUrl");
    if (action === undefined) throw new Error(`no button "${button}" on message ${message.id}`);
    const values = picked.map((t) => card.choices?.options.find((o) => o.title === t)?.value ?? "missing");
    const inputs = card.choices === undefined || picked.length === 0 ? {} : { [card.choices.id]: values.join(",") };
    const data = { ...(isJson(action["data"]) ? action["data"] : {}), ...inputs };
    await this.post({
      ...this.base(chat, from),
      type: "invoke",
      name: "adaptiveCard/action",
      replyToId: message.id,
      value: { action: { type: "Action.Execute", verb: action["verb"], data } },
    });
  }

  seen(chat?: KitChat): readonly SeenMessage[] {
    return this.connector.recorder.records.flatMap((r) => {
      const seen = chat === undefined || r.conversation === chat.id ? seenOf(r) : undefined;
      return seen === undefined ? [] : [seen];
    });
  }

  close(): Promise<void> {
    return this.connector.close();
  }
}

/** The Teams surface under the conformance kit. */
export function teamsUnderTest(): SurfaceUnderTest {
  return { name: "teams", open: async () => new TeamsDriver(await RecordingConnector.start()) };
}
