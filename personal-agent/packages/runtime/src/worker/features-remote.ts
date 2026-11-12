// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Agents on a person's own machines (Python `remote.RemoteAgents` as `Agent.__init__` builds it): REMOTE_AGENTS_ENABLED, what
 * an attached chat hears between turns (REMOTE_PUSH_ENABLED), where its chat box goes by default (REMOTE_WINDOW_DEFAULT), the
 * person's limits, and a credential for a reader with nobody to ask.
 */
import { createHash } from "node:crypto";

import type { DirectChat, FollowReach, PublicErrors, RemoteContext, RemoteErrors } from "@primusclaw/personal-agent";
import {
  answerLang,
  remoteView,
  ConnectorSetup,
  CredentialUnavailable,
  FollowCredentialUnavailable,
  Guardrails,
  looksInternal,
  newRef,
  RemoteAgents,
  REMOTE_FOLLOW_TIMINGS,
  REMOTE_WATCH_TIMINGS,
  setupFrom,
  splitErrorTail,
} from "@primusclaw/personal-agent";

import type { AssemblyBase, RouterHooks } from "./features-base.js";
import type { FeatureSwitches } from "./features-switches.js";
import { conversationFor } from "./features-proactive.js";

function remoteErrors(base: AssemblyBase, errors: PublicErrors): RemoteErrors {
  return {
    withhold: (where, detail, ids) => errors.withhold(where, detail, ids),
    publicReason: (reason, where, ids) => errors.publicReason(reason, where, ids),
    looksInternal: (text) => looksInternal(text),
    splitErrorTail: (text) => splitErrorTail(text),
    newRef: () => newRef(base.random),
  };
}

export interface RemoteInputs {
  readonly switches: FeatureSwitches;
  readonly guard: Guardrails;
  readonly reach: FollowReach;
  readonly errors: PublicErrors;
  readonly directChat: DirectChat;
  readonly hooks: RouterHooks;
}

export function remoteAgents(base: AssemblyBase, inputs: RemoteInputs): RemoteAgents {
  const { store, claw, settings, securityLog } = base;
  const { switches, guard } = inputs;
  const ctx: RemoteContext = {
    views: remoteView.createRemoteViews(),
    settings: {
      enabled: switches.remoteAgents,
      follow: switches.remotePush,
      windowDefault: switches.remoteWindow,
      timings: REMOTE_FOLLOW_TIMINGS,
      watchTimings: REMOTE_WATCH_TIMINGS,
      botName: "Clawy",
      streaming: base.surface.caps.streaming,
    },
    claw: claw.remoteAgents,
    clawBaseUrl: settings.clawApiUrl,
    setup: new ConnectorSetup(setupFrom(null, settings.clawApiUrl)),
    remoteState: store.remoteState,
    sessionNames: store.remoteSessionNames,
    permissions: store.remotePermissions,
    prefs: store.prefs,
    references: store.references,
    conversationFor: conversationFor(base),
    credentialFor: async (person) => {
      try {
        return (await inputs.hooks.background(person)) ?? null;
      } catch (error) {
        // (the router's and the follower's "not just now" are two classes: the follower waits only on its own)
        if (error instanceof CredentialUnavailable) throw new FollowCredentialUnavailable();
        throw error;
      }
    },
    reach: inputs.reach,
    guard: {
      take: (person, operation, ticket, ids) => guard.take(person, operation, ticket, ids ?? {}),
      giveBack: (person, operation, ticket) => {
        guard.giveBack(person, operation, ticket ?? undefined);
      },
    },
    audit: (event, fields) => {
      securityLog.event(event, fields);
    },
    errors: remoteErrors(base, inputs.errors),
    clock: base.clock,
    random: base.random,
    logger: base.logger,
    digestHex: (algorithm, text) => createHash(algorithm).update(text, "utf8").digest("hex"),
    langOf: (person) => answerLang(store.prefs.getPrefs(person).lang, ""),
    directChat: inputs.directChat,
  };
  return new RemoteAgents(ctx);
}
