// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A Teams conversation over a fake outbox, a fake clock and a seeded random, as the messenger tests build it. */
import type { ConversationRef } from "@primusclaw/personal-agent";

import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { DEFAULT_STYLE, type Style } from "../../src/config/style.js";
import { teamsCaps } from "../../src/caps.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import { TeamsConversation } from "../../src/messenger/conversation.js";
import type { Masker } from "../../src/messenger/masker.js";
import type { Outbox } from "../../src/outbound/outbox.js";
import { BusyConversations } from "../../src/stream/busy.js";
import { RENDERERS } from "../../src/views/index.js";
import type { Renderers } from "../../src/views/registry.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";

export function ref(id = "conv", conversationType = "personal"): ConversationRef {
  return {
    id,
    kind: conversationType === "groupChat" ? "group" : "personal",
    tenantId: "",
    wire: {
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      conversation: { id, conversationType },
      activityId: "user-msg-1",
    },
  };
}

export interface Built {
  readonly conversation: TeamsConversation;
  readonly clock: FakeClock;
  readonly acks: AckRegistry;
  readonly logger: RecordingLogger;
  readonly busy: BusyConversations;
}

export interface BuildOptions {
  readonly ref?: ConversationRef;
  readonly ackTimeoutMs?: number;
  readonly style?: Style;
  readonly masker?: Masker;
  readonly renderers?: Renderers;
  readonly clock?: FakeClock;
  readonly acks?: AckRegistry;
}

export function build(outbox: Outbox, options: BuildOptions = {}): Built {
  const clock = options.clock ?? new FakeClock();
  const logger = new RecordingLogger();
  const acks = options.acks ?? new AckRegistry(clock, logger);
  const busy = new BusyConversations(clock);
  const style = options.style ?? DEFAULT_STYLE;
  const conversation = new TeamsConversation({
    ref: options.ref ?? ref(),
    caps: teamsCaps("direct"),
    outbox,
    acks,
    clock,
    random: new SeededRandom(7),
    render: { style, renderers: options.renderers ?? RENDERERS, masker: options.masker },
    stream: { style, clock, busy, logger },
    logger,
    ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
  });
  return { conversation, clock, acks, logger, busy };
}
