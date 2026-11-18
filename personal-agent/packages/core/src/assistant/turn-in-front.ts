// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn that holds the assistant's session when a message is handed over (teams_agent/assistant.py `_read_turn_in_front`,
 * `_turn_in_front`): read beside the receipt being opened, and waited for just before the send, at most FRONT_TURN_SECONDS. A
 * message Claw queues runs after that turn, whose replies are not its answer (`Receipt.answeredBy`).
 */
import { errorName } from "../errors.js";
import type { ClawSessionsPort } from "../ports/claw/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { Receipt } from "./receipt.js";

/** How long the turn in front of a message is waited for; later, the receipt does without (the first reply closes it). */
export const FRONT_TURN_SECONDS = 2.0;

export interface TurnInFrontDeps {
  readonly sessions: Pick<ClawSessionsPort, "turn">;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class TurnInFront {
  private abandoned = false;
  private readonly read: Promise<string | undefined>;

  /** Starts reading which turn holds `sessionId` now: its message id while it runs, else none. */
  constructor(
    private readonly deps: TurnInFrontDeps,
    credential: string,
    sessionId: string,
  ) {
    this.read = deps.sessions.turn(credential, sessionId).then(
      (turn) => (turn.running ? (turn.messageId ?? undefined) : undefined),
      (error: unknown) => {
        // (Claw down, an older Claw, a refusal: nothing is known of the turn in front)
        if (!this.abandoned) {
          deps.logger.info("the turn in front of a message to the assistant was not read", { error: errorName(error) });
        }
        return undefined;
      },
    );
  }

  /**
   * The turn read, just before the message is sent: undefined when this message has no receipt, the session was idle, or Claw
   * did not say within FRONT_TURN_SECONDS (the receipt is then closed by the first reply, as before).
   */
  async before(receipt: Receipt | undefined): Promise<string | undefined> {
    if (receipt === undefined) {
      this.abandon();
      return undefined;
    }
    const timer = new AbortController();
    const waited = this.deps.clock.sleep(FRONT_TURN_SECONDS * 1000, timer.signal).then(
      () => ({ late: true as const }),
      () => ({ late: true as const }),
    );
    try {
      const read = await Promise.race([this.read.then((turn) => ({ late: false as const, turn })), waited]);
      if (!read.late) return read.turn;
      this.deps.logger.info("the turn in front of a message to the assistant was not read in time");
      return undefined;
    } finally {
      timer.abort();
    }
  }

  /** The message went (or never will): whatever the read still brings is not wanted. */
  abandon(): void {
    this.abandoned = true;
  }
}
