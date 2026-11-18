// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's services a deployment's plugins are built with (`WorkerServices`): the store's reads, a post into a chat,
 * and a message handled as the person's own (the Python worker's `Agent.on_behalf`: `activity_of_reference` with the text,
 * handled in a task of its own with provenance "on_behalf"). The router is bound once it is built.
 */
import {
  errorName,
  type ConversationRef,
  type InboundEvent,
  type JsonObject,
  type Logger,
  type MessageId,
  type Router,
  type SecurityLog,
  type Surface,
} from "@primusclaw/personal-agent";
import type { SqliteStore } from "@primusclaw/personal-agent-runtime";

import type { WorkerServices } from "./worker-api.js";

export interface ServicesParts {
  readonly store: SqliteStore;
  readonly surface: Surface;
  readonly securityLog: SecurityLog;
  readonly logger: Logger;
  /** A stored conversation reference back as core's (the surface's `restoreRef`). */
  readonly restoreRef: (stored: JsonObject) => ConversationRef | undefined;
  /**
   * `text` as the event the surface would have made of the person's own message `messageId` in `conversation` (the
   * surface's `typedEvent`); undefined when it cannot be read.
   */
  readonly typedEvent: (conversation: ConversationRef, messageId: MessageId, text: string) => InboundEvent | undefined;
}

/** The services, the router they wait for, and the background tasks to wait for when the worker stops. */
export interface BoundServices {
  readonly services: WorkerServices;
  bind(router: Router): void;
  /** Resolves when every task spawned so far has ended. */
  idle(): Promise<void>;
}

export function workerServices(parts: ServicesParts): BoundServices {
  const { store, surface, securityLog, logger } = parts;
  const late: { router?: Router } = {};
  const tasks = new Set<Promise<void>>();
  const router = (): Router => {
    if (late.router === undefined)
      throw new Error("the worker is not assembled yet: a plugin called it while it was built");
    return late.router;
  };
  const services: WorkerServices = {
    channelUsersOf: (clawUserId) => store.links.usersForClawUser(clawUserId),
    clawUserOf: (userId) => store.links.clawUserIdOf(userId) ?? undefined,
    hasKey: (userId) => store.links.getKey(userId) !== null,
    conversationOf: (userId) => {
      const stored = store.references.getReference(userId);
      return stored === null ? undefined : parts.restoreRef(stored);
    },
    knownPeople: () => store.members.knownMembers().map((m) => ({ name: m.name, objectId: m.objectId })),
    post: (conversation, text) => surface.conversation(conversation).post({ body: { type: "text", text } }),
    async handleAsTyped(conversation: ConversationRef, userId: string, messageId: string, text: string) {
      const read = parts.typedEvent(conversation, messageId, text);
      if (read?.type !== "message" || read.sender.id !== userId) {
        logger.warn("a message sent on someone's behalf could not be read as theirs; not handled");
        return;
      }
      await router().handle({ ...read, provenance: "on_behalf" });
    },
    spawn(task) {
      router();
      const running = task().catch((error: unknown) => {
        logger.error("a background task of a plugin failed", { error: errorName(error) });
      });
      tasks.add(running);
      void running.finally(() => tasks.delete(running));
    },
    audit(fields) {
      securityLog.event("on_behalf_message", { ...fields, operation: "on_behalf" }); // (the operation is always this one)
    },
    logger,
  };
  return {
    services,
    bind(built) {
      late.router = built;
    },
    idle: async () => {
      // (a task may spawn another: wait until none is left)
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
  };
}
