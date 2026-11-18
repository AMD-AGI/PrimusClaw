// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The echo surface's own wire: what its made-up chat app delivers and what it shows. It stands for a real platform's
 * events and messages (a Slack event, a Teams activity); `docs/adding-a-surface.md` walks through it. Nothing here is
 * core's: core sees `InboundEvent`s and `OutMessage`s only.
 */

/** A chat on the echo app: a 1:1 chat with the bot, or a group chat. */
export interface EchoChat {
  readonly id: string;
  readonly kind: "personal" | "group";
}

/** A person on the echo app: their stable id and the name it shows. */
export interface EchoPerson {
  readonly id: string;
  readonly name: string;
}

/** A button as the echo app draws it: one that calls the bot back (`data`), or one that opens a link. */
export type EchoButton =
  | { readonly title: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly title: string; readonly url: string };

/** A pick-one or pick-several list on a message; what is picked is sent with the next button press, under `id`. */
export interface EchoChoices {
  readonly id: string;
  readonly multiple: boolean;
  readonly options: readonly { readonly title: string; readonly value: string }[];
}

/** A message as the echo app shows it. */
export interface EchoMessage {
  readonly text: string;
  readonly buttons: readonly EchoButton[];
  readonly choices?: EchoChoices;
  /** People the message @mentions, by their echo id. */
  readonly mentions: readonly string[];
}

/** What the echo app delivers to the bot. */
export type EchoEvent =
  | {
      readonly type: "message";
      readonly id: string;
      readonly chat: EchoChat;
      readonly from: EchoPerson;
      readonly text: string;
      /** The message @mentions the bot (in a group the bot answers only then). */
      readonly mentionsBot?: boolean;
    }
  | {
      readonly type: "press";
      readonly id: string;
      readonly chat: EchoChat;
      readonly from: EchoPerson;
      /** The message that holds the button. */
      readonly messageId: string;
      /** The pressed button's `data`. */
      readonly data: Readonly<Record<string, unknown>>;
      /** What was picked on the message's choices, by the choices' `id`. */
      readonly inputs?: Readonly<Record<string, string>>;
    };

/** One thing the bot did on the echo app, in order: what a test reads back. */
export type EchoRecord =
  | { readonly op: "typing"; readonly chat: string }
  | { readonly op: "post"; readonly chat: string; readonly id: string; readonly message: EchoMessage }
  | { readonly op: "edit"; readonly chat: string; readonly id: string; readonly message: EchoMessage }
  | { readonly op: "delete"; readonly chat: string; readonly id: string }
  | { readonly op: "stream"; readonly chat: string; readonly id: string; readonly text: string; readonly final: false }
  | {
      readonly op: "stream";
      readonly chat: string;
      readonly id: string;
      readonly message: EchoMessage;
      readonly final: true;
    };

/** The stored reference of an echo chat: what core keeps and hands back to post there later. */
export interface EchoWire extends Readonly<Record<string, unknown>> {
  readonly chat: EchoChat;
  /** The message this reference was read from ("" for none): what a live stream answers. */
  readonly messageId: string;
  /** Who wrote that message: whose words a message sent on their behalf here would be. */
  readonly from?: EchoPerson;
}
