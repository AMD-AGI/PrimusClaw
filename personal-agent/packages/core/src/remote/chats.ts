// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What this process knows of each chat attached to a remote session, beside what the store keeps: what reads the session now (a
 * turn, a short watch, the follower), what its connector reported when the chat attached, whether the session only watches a
 * conversation open in a terminal, and the one-time tokens of the cards it showed. Keyed by the chat key (`chat-key.ts`). All of it
 * is lost when the process restarts, as it was in the Python worker; what must survive is in the store.
 */
import type { Follower } from "./follow/follower.js";
import type { Task } from "./tasks.js";

/** Folders typed in a `/agent new MACHINE PATH` kept for the buttons of the card that asks which agent, per chat. */
export const TYPED_PATHS_KEPT = 20;
export const TYPED_PATH_SECONDS = 3600;
/** How long a takeover's confirmation card can be answered. */
export const TAKEOVER_CONFIRM_SECONDS = 600;

/** A turn this process is reading: its task, and whether the person asked to stop it. */
export interface RemoteTurn {
  task: Task | null;
  stopRequested: boolean;
  /** Its message waits for the machine's terminal and has not been typed there yet. */
  waitsForTerminal: boolean;
  /** Nothing runs it any more (or nothing ever did): a Stop card's press for it stops nothing. */
  readonly ended: boolean;
}

/**
 * A message sent to the attached session while a turn of the chat still ran. Claw keeps it in order and the machine runs it once the
 * turn in front has ended (the connector queues it, as Claude Code queues what is typed while it works); its own turn is read right
 * after the one in front (`TurnRunner`).
 */
export interface QueuedPrompt {
  /** Claw's sequence number of the prompt (a refusal of it names it); undefined when Claw did not give one. */
  readonly cmdSeq: number | undefined;
  /** Start reading its turn: false when it cannot be (the chat is no longer attached to that session). */
  start(): boolean;
}

/** At most this many messages wait behind a running turn (the connector refuses more: `too_many_queued_prompts`). */
export const QUEUED_PROMPTS_MAX = 5;

/** A turn about to be watched (its task is set right after). */
export function newTurn(): RemoteTurn {
  return {
    task: null,
    stopRequested: false,
    waitsForTerminal: false,
    get ended() {
      return this.task?.running !== true;
    },
  };
}

/** The confirmation card for taking over a conversation a terminal has open: only its own Take over carries the ticket. */
export interface TakeoverTicket {
  readonly connectorId: string;
  readonly agentId: string;
  readonly ref: string;
  readonly ticket: string;
  /** Wall-clock seconds. */
  readonly until: number;
}

export class ChatRegistry {
  /** The reader of the attached session while no turn reads it. */
  readonly followers = new Map<string, Follower>();
  /** Chats `forget` was called for: nothing follows them until they attach again. */
  readonly unlinked = new Set<string>();
  readonly turns = new Map<string, RemoteTurn>();
  /** The messages sent while the chat's turn ran, oldest first: each one's turn is read after the one in front. */
  private readonly queuedPrompts = new Map<string, QueuedPrompt[]>();
  /** A short watch (`/agent new` waiting for the agent, `/agent mode` for its answer). */
  readonly watchers = new Map<string, Task>();
  /** Whether the agent of the attached session starts in a mode that does not ask (its connector's report). */
  readonly agentUnattended = new Map<string, boolean>();
  /** Whether the agent of the attached session can take over a conversation a terminal has open. */
  readonly agentTakeover = new Map<string, boolean>();
  private readonly typed = new Map<string, Map<string, { path: string; until: number }>>();
  private readonly readOnly = new Map<string, string>();
  private readonly readOnlyKnown = new Map<string, string>();
  private readonly terminalInput = new Map<string, string>();
  private readonly tickets = new Map<string, TakeoverTicket>();

  /** How many messages wait behind the chat's running turn. */
  queuedCount(chatKey: string): number {
    return this.queuedPrompts.get(chatKey)?.length ?? 0;
  }

  enqueue(chatKey: string, prompt: QueuedPrompt): void {
    const queue = this.queuedPrompts.get(chatKey) ?? [];
    queue.push(prompt);
    this.queuedPrompts.set(chatKey, queue);
  }

  /** The oldest message waiting, taken off the queue. */
  takeQueued(chatKey: string): QueuedPrompt | undefined {
    const queue = this.queuedPrompts.get(chatKey);
    const next = queue?.shift();
    if (queue?.length === 0) this.queuedPrompts.delete(chatKey);
    return next;
  }

  /** The waiting message Claw numbered `cmdSeq` (refused before it ran), taken off the queue. */
  takeQueuedSeq(chatKey: string, cmdSeq: number): QueuedPrompt | undefined {
    const queue = this.queuedPrompts.get(chatKey);
    const at = queue?.findIndex((q) => q.cmdSeq === cmdSeq) ?? -1;
    if (queue === undefined || at < 0) return undefined;
    const [taken] = queue.splice(at, 1);
    if (queue.length === 0) this.queuedPrompts.delete(chatKey);
    return taken;
  }

  /** Every waiting message is given up (a stop drops them on the machine too); how many there were. */
  dropQueued(chatKey: string): number {
    const count = this.queuedCount(chatKey);
    this.queuedPrompts.delete(chatKey);
    return count;
  }

  watching(chatKey: string): boolean {
    return this.watchers.get(chatKey)?.running ?? false;
  }

  /** The chat's session only watches a conversation open in a terminal (read-only). */
  watches(chatKey: string, sessionId: string | null): boolean {
    return sessionId !== null && this.readOnly.get(chatKey) === sessionId;
  }

  /** Whether this process has learned (from an event, or by reading back) whether the session only watches. */
  knowsWatch(chatKey: string, sessionId: string): boolean {
    return this.readOnlyKnown.get(chatKey) === sessionId;
  }

  learnedWatch(chatKey: string, sessionId: string): void {
    this.readOnlyKnown.set(chatKey, sessionId);
  }

  markReadOnly(chatKey: string, sessionId: string, readOnly: boolean): void {
    this.readOnlyKnown.set(chatKey, sessionId);
    if (readOnly) this.readOnly.set(chatKey, sessionId);
    else if (this.readOnly.get(chatKey) === sessionId) this.readOnly.delete(chatKey);
  }

  /** A new session says itself whether it only watches. */
  clearReadOnly(chatKey: string): void {
    this.readOnly.delete(chatKey);
  }

  markTerminal(chatKey: string, sessionId: string, terminal: boolean): void {
    if (terminal) this.terminalInput.set(chatKey, sessionId);
    else if (this.terminalInput.get(chatKey) === sessionId) this.terminalInput.delete(chatKey);
  }

  /** What is sent to the chat's session is typed into a terminal on the machine. */
  typesIntoTerminal(chatKey: string, sessionId: string | null): boolean {
    return sessionId !== null && this.terminalInput.get(chatKey) === sessionId;
  }

  /**
   * Keep a folder typed for the buttons of the card that asks which agent (a token names it: the card can say where a session goes,
   * a tap cannot choose it). A few per chat, for an hour. `now`: wall-clock seconds.
   */
  rememberPath(chatKey: string, path: string, token: string, now: number): string {
    const kept = new Map([...(this.typed.get(chatKey) ?? [])].filter(([, v]) => v.until > now));
    kept.set(token, { path, until: now + TYPED_PATH_SECONDS });
    for (const oldest of kept.keys()) {
      if (kept.size <= TYPED_PATHS_KEPT) break;
      kept.delete(oldest);
    }
    this.typed.set(chatKey, kept);
    return token;
  }

  typedPath(chatKey: string, token: string, now: number): string | null {
    const found = this.typed.get(chatKey)?.get(token);
    return found && found.until > now ? found.path : null;
  }

  /** Remember the takeover card shown last to this chat (the previous one is replaced: only the last can start a takeover). */
  issueTicket(chatKey: string, ticket: TakeoverTicket): void {
    this.tickets.set(chatKey, ticket);
  }

  ticketOf(chatKey: string): TakeoverTicket | undefined {
    return this.tickets.get(chatKey);
  }

  /** The ticket is used: a takeover starts from that card once. */
  spendTicket(chatKey: string): void {
    this.tickets.delete(chatKey);
  }

  /** Everything known of a chat whose person unlinked (its session's reader is stopped by the caller). */
  forget(chatKey: string): void {
    this.typed.delete(chatKey);
    this.agentUnattended.delete(chatKey);
    this.readOnly.delete(chatKey);
    this.readOnlyKnown.delete(chatKey);
    this.queuedPrompts.delete(chatKey);
  }
}
