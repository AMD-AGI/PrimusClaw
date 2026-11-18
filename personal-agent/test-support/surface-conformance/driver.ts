// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a surface package gives the conformance kit (`surfaceConformance`): how to build its worker, its own settings for a
 * test run, and a driver that speaks its platform's wire. The kit says what people do in surface-neutral words (Alice
 * writes "hello" in her 1:1 chat, presses Approve on the card she was shown); the driver turns that into what the
 * platform would deliver (a Teams activity, an echo event) and reads what reached the chat back in the same words. The
 * kit never sees a card's JSON or an activity.
 */
import type { SurfaceCaps } from "@primusclaw/personal-agent";
import type { BuildWorker, WorkerEnv } from "@primusclaw/personal-agent-runtime/worker";

/** A person in the kit's chats. `id` is the id the surface gives core as `UserRef.id` (their directory id). */
export interface KitPerson {
  readonly id: string;
  readonly name: string;
}

/** A chat in the kit: a 1:1 chat with the bot or a group chat. `id` is the conversation id core sees. */
export interface KitChat {
  readonly id: string;
  readonly kind: "personal" | "group";
}

/** A button as a person sees it: its words, and where it goes when it opens a link. */
export interface SeenButton {
  readonly title: string;
  readonly url?: string;
}

/** Something the bot showed in a chat, read back from the platform's wire. */
export interface SeenMessage {
  readonly chat: string;
  /** The platform's id of the message (an edit or a stream's next request names the same id). */
  readonly id: string;
  /** A new message, an edit of one, or a request of a live stream. */
  readonly op: "post" | "edit" | "stream";
  /** For a stream: its final message (it is closed). True for posts and edits. */
  readonly final: boolean;
  /** Every word a person reads on it (a card's text blocks, facts and titles, joined by new lines). */
  readonly text: string;
  readonly buttons: readonly SeenButton[];
  /** The options of a pick list on it, in order ([] for none). */
  readonly choices: readonly string[];
  /** The people it @mentions, by `KitPerson.id`. */
  readonly mentions: readonly string[];
}

export interface SayOptions {
  /** In a group: the message @mentions the bot. */
  readonly mentionsBot?: boolean;
}

/** One run's connection to the surface's platform (or its stand-in). */
export interface ChatDriver {
  /** The surface package's `buildWorker` (`assembleWorker` with its `SurfaceAdapter`), as this run builds it. */
  readonly buildWorker: BuildWorker;
  /** The surface's own settings for this run: the worker's environment adds core's to them. */
  readonly env: WorkerEnv;
  /** What the surface says it can do in this run (its `Surface.caps`). */
  readonly caps: SurfaceCaps;
  /** The worker is listening at `baseUrl` (http://127.0.0.1:<port>): where a webhook-style inbound side is reached. */
  attach(baseUrl: string): void;
  /** `from` writes `text` in `chat`; resolves when the worker has taken it (the platform's delivery was answered). */
  say(chat: KitChat, from: KitPerson, text: string, options?: SayOptions): Promise<void>;
  /**
   * `from` presses the button titled `button` on `message`, with the options titled `picked` ticked on its pick list;
   * resolves when the worker has taken the press.
   */
  press(
    chat: KitChat,
    from: KitPerson,
    message: SeenMessage,
    button: string,
    picked?: readonly string[],
  ): Promise<void>;
  /** Everything shown so far, in order; in one chat when `chat` is given. Typing indicators are left out. */
  seen(chat?: KitChat): readonly SeenMessage[];
  close(): Promise<void>;
}

/** A surface package under test. */
export interface SurfaceUnderTest {
  /** The surface's name, in the tests' titles. */
  readonly name: string;
  /** Start what the surface talks to in a test (its platform's stand-in) and return the driver of one run. */
  open(): Promise<ChatDriver>;
}
