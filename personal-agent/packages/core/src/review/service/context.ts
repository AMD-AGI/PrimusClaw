// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the review service reads a request from (the message, or a press of a button that asks it again). */

import type { Conversation, InboundMessage, UserRef } from "../../ports/surface.js";

/** Where and by whom a request was made. */
export interface RequestContext {
  readonly message: InboundMessage;
  readonly sender: UserRef;
  readonly conversation: Conversation;
  readonly scope: string;
  /** What the person wrote (the asker's note to the reviewer). */
  readonly text: string;
  readonly group: boolean;
}
