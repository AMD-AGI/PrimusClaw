// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who hears a session delete, and who acts on it.
 *
 * The API publishes one `cleanup.<sid>` per delete on core NATS. It carries two
 * jobs that need different audiences:
 *
 *   - forget the session: mark it deleted, abort its runs and drop this
 *     process's own references to its sandbox. A run lives on whichever replica
 *     took it, and the token and keepalive registrations are per process, so
 *     every replica has to do this.
 *   - tear down what the session owns on the platform: list its workloads,
 *     delete them, then remove or park its `hands.<sid>` binding. That is the
 *     same work whichever replica does it, and it only needs doing once.
 *
 * Both used to run on one plain subscription, so every Brain replica did the
 * whole teardown: three SaFE listings and three rounds of deletes per session
 * delete, three conditional writes racing for one binding, and every
 * `session.cleanup_incomplete_parked` logged and counted once per replica. The
 * teardown now runs on a queue-group subscription, which NATS delivers to one
 * member of the group, while the forget half keeps a plain one.
 *
 * A teardown that is lost with the replica that took it is not lost for good:
 * the API parks `hands.<sid>` with `sessionDeleted` on it, and Brain's sweeps
 * act on that with no message needed (see api/src/sessions/teardown.ts).
 */

/** The queue group the compute teardown is delivered to. One name for every Brain version. */
export const SESSION_CLEANUP_QUEUE = "brain-session-cleanup";

/** The subject the API publishes a session delete on. */
export const SESSION_CLEANUP_SUBJECT = "cleanup.*";

export interface CleanupMessage {
  subject: string;
  data: Uint8Array;
}

export interface SessionCleanupSubscriberDeps {
  /** `nc.subscribe`, narrowed to what is used here. */
  subscribe: (subject: string, opts?: { queue?: string }) => AsyncIterable<CleanupMessage>;
  /** Every replica: forget the session locally. */
  forget: (sessionId: string) => Promise<void>;
  /** One replica: tear down what the session owns on the platform. */
  teardown: (sessionId: string, payload: Uint8Array) => Promise<void>;
  onError: (err: unknown, sessionId: string, half: "forget" | "teardown") => void;
}

function sessionIdOf(subject: string): string {
  const parts = subject.split(".");
  return parts[parts.length - 1];
}

/**
 * Subscribe both halves. Each loop handles its messages one at a time, as the
 * single loop did, and a failure in one message does not end the loop.
 */
export function installSessionCleanupSubscribers(deps: SessionCleanupSubscriberDeps): void {
  const run = (
    iter: AsyncIterable<CleanupMessage>,
    half: "forget" | "teardown",
    handle: (sid: string, msg: CleanupMessage) => Promise<void>,
  ) => {
    void (async () => {
      for await (const msg of iter) {
        const sid = sessionIdOf(msg.subject);
        try {
          await handle(sid, msg);
        } catch (err) {
          deps.onError(err, sid, half);
        }
      }
    })();
  };
  run(deps.subscribe(SESSION_CLEANUP_SUBJECT), "forget", (sid) => deps.forget(sid));
  run(
    deps.subscribe(SESSION_CLEANUP_SUBJECT, { queue: SESSION_CLEANUP_QUEUE }),
    "teardown",
    (sid, msg) => deps.teardown(sid, msg.data),
  );
}
