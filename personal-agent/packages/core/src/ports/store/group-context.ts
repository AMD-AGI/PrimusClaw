// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The group chats that turned the recent-messages context off (`/context off`). Only the switch is kept: the messages
 * themselves are never stored (they live in the worker's memory, `group-context/buffer.ts`).
 */
export interface GroupContextRepository {
  /** True when the chat turned the context off. */
  contextOff(conversationId: string): boolean;
  /** Turns it off (`off` true) or back on. */
  setContextOff(conversationId: string, off: boolean): void;
}
