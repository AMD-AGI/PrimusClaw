// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// delivery/dispatch.ts
//
// What one pod does with one delivery, from the moment it arrives to the moment
// it is settled.
//
// This was four lines inside the consumer loop, and the shape of those four
// lines was the bug. `await gate.acquire()` in the loop body holds the
// `for await` for the length of a whole run, while `consume({ max_messages })`
// keeps refilling the client's buffer from the server. Those buffered messages
// have been delivered and their ack timers are running, but the loop has not
// reached them, so nothing calls `working()` on them: at the shipped
// MAX_CONCURRENT=3 / MAX_RESIDENT=6 at least two messages sit in that state
// whenever a pod is saturated. Each is redelivered every ack_wait and each
// redelivery spends one of the delivery budget, so a pod busy for twenty
// minutes -- ordinary for an agent loop -- drives a healthy task that never
// started to the poison guard, where it is reported to the user as a failure.
// Worse, if a redelivered copy runs elsewhere first, the buffered copy finds
// the lock free and runs the same turn a second time.
//
// So the loop must not be held. Each delivery waits for its slot on its own,
// with its own heartbeat already running, and the loop keeps draining the
// buffer. What the gate is for is untouched -- no sandbox is provisioned until
// a slot is free.
//
// That leaves the question of how many deliveries a pod may hold at once, and
// `consume({ max_messages })` is not the answer to it: the client counts a
// message as no longer pending the moment it arrives and immediately asks for
// another, whether or not the application has looked at it. Nothing about that
// depends on this loop -- it was equally true when the loop blocked, which is
// why the messages the reviewer found were piling up in the client's buffer at
// all. So the number a pod holds is bounded only by the stream's
// `max_ack_pending`, which the whole fleet shares, and one saturated pod can
// take enough of it that idle pods are offered nothing.
//
// The execution gate is what must refuse, not a residency ceiling well above
// it. A pod at MAX_CONCURRENT long jobs never reaches
// MAX_RESIDENT + MAX_CONCURRENT held deliveries, so a refuse-when-residency-full
// check never fired: the extras sat on `gate.acquire()` with a heartbeat, and
// idle replicas were offered nothing. Refusing when `!gate.admissible()` hands
// the message back while siblings still have slots. Residency still counts
// overflow -- a delivery past the refusal allowance is kept rather than
// refused -- so finishing an in-ceiling run cannot make the pod look empty
// while those are held.
//
// A refusal is not free, and what it costs is the reason it is rationed. Each
// one spends a delivery from a budget that is shared with the refusals for a
// held lock and sized for them, and a message that runs out is resolved as a
// failed task and reported to the user, having never run. Worse, the guard
// that reports it lives past the admission check, so a message refused every
// time would never reach it: the stream would simply stop redelivering, with
// no event and the session left running forever.
//
// A saturated pod is also the fastest consumer in the fleet -- refusing is
// instant, so nothing slows its pulling -- which means it wins redeliveries it
// cannot run and spends their budget on them.
//
// So a delivery may be refused SURPLUS_REFUSALS times and no more. That is
// enough to find a replica with room, which is the whole job. Past the
// allowance the pod keeps the message, over the gate, heartbeating it until it
// has room -- and, whatever else happens, it reaches the guard. Fleet-wide
// saturation (every replica full) is the case that cap exists for: unbounded
// refusal would burn the delivery budget in seconds and report healthy work as
// poisoned.

import { AsyncLocalStorage } from "node:async_hooks";

import { isRunDoorbell, type ExecuteRequest } from "@claw/protocol";
import type { JsMsg } from "nats";

import { BRAIN_ID, RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS } from "../config.js";
import { askRunLease, type LeaseRenewal } from "../tasks/callback.js";

/**
 * How long a delivery refused during a drain waits before coming back.
 *
 * Short, because the refusal says "not this pod" rather than "not yet": the
 * message is wanted, and every other replica is able to take it.
 */
export const DRAIN_NAK_MS = 5_000;

/**
 * How many times one delivery may be handed back for lack of room.
 *
 * Small on purpose. Each refusal is a question -- "does anyone else have room
 * right now?" -- and after a few identical answers the fleet is saturated, at
 * which point asking again costs a delivery and tells nobody anything. Three
 * spans about half a minute on the shared backoff curve, long enough for a run
 * to finish on a neighbour and short enough to leave the rest of the budget to
 * the thing it was sized for.
 */
export const SURPLUS_REFUSALS = 3;

/**
 * How many deliveries this pod is holding, against the ceiling on it.
 *
 * Held means accepted and not yet settled, which covers a run that is
 * executing, one queued for a slot, and one parked on an approval. All three
 * are deliveries this pod has taken responsibility for and no other replica
 * can be given.
 */
export class DeliveryResidency {
  private held = 0;

  constructor(private readonly max: number) {
    if (max <= 0) throw new Error(`DeliveryResidency max must be > 0, got ${max}`);
  }

  /**
   * Whether a refuse-able delivery should be handed back.
   *
   * Over the ceiling is still "full": a must-keep is counted above `max` so
   * that finishing an in-ceiling run does not make the pod look empty while
   * those overflows are still held.
   */
  get full(): boolean {
    return this.held >= this.max;
  }

  /**
   * Take a place. Over the ceiling is allowed: a must-keep is held rather
   * than refused. Every `take` needs exactly one `leave`.
   */
  take(): void {
    this.held++;
  }

  leave(): void {
    if (this.held > 0) this.held--;
  }

  /** Deliveries this pod is holding right now. */
  get holding(): number {
    return this.held;
  }
}

/**
 * Why a delivery must not enter the task handler after all.
 *
 * Each is a conclusion the row reached while this pod was queued for a slot,
 * which is the window nothing else can observe: the interrupt subject a
 * Stop publishes on has no subscriber until the run starts, so the lease is
 * the only channel a Stop can reach a queued delivery through.
 */
export type DeliveryStop = "cancelling" | "gone" | "superseded";

/** What the first lease POST concluded. */
export type Acceptance =
  /** The lease is this pod's. `stop` is set when the row is already over. */
  | { kind: "held"; runClaim?: number; stop?: DeliveryStop }
  /** Terminal or missing: nobody holds anything, so the delivery is settled. */
  | { kind: "gone" }
  /** Taken, or no answer at all. Neither is a lease, so nothing may run. */
  | { kind: "refused" };

/** The pre-gate lease renewal, which is also the stop channel. */
export interface PreGateHeartbeat {
  /** Idempotent: the handoff and the delivery's `finally` both call it. */
  stop(): void;
}

/**
 * The lease half of a fat delivery, injected so this module stays free of the
 * event emitter and the HTTP client.
 */
export interface FatPreGate {
  /** The fat, non-doorbell delivery this message is, or null for anything else. */
  target(msg: JsMsg): FatTarget | null;
  /** The first lease: `accept: true`, waited on until the answer is conclusive. */
  accept(target: FatTarget): Promise<Acceptance>;
  heartbeat(
    target: FatTarget, runClaim: number | undefined, onStop: (stop: DeliveryStop) => void,
  ): PreGateHeartbeat;
  /** The interrupted completion a delivery stopped before the handler settles with. */
  settleStopped(target: FatTarget, runClaim: number | undefined): Promise<void>;
}

/** The parsed delivery, which is what every step of the protocol acts on. */
export type FatTarget = ExecuteRequest;

/**
 * The generation, and the renewal handoff, for the delivery the handler is
 * running under.
 *
 * Carried out of band rather than threaded through the handler signature
 * because every layer between here and the runner would otherwise have to know
 * about a fact only the lease cares about. The generation belongs to the
 * delivery for its whole life: `postRunLease` sends it on every renewal any
 * owner makes, and every `exec_complete` names it.
 */
export interface FatDeliveryContext {
  runClaim?: number;
  /**
   * The runner has started its own lease renewal and owns it from here. Until
   * it is called the delivery layer keeps renewing, so the two owners overlap
   * rather than leaving the lease unrenewed between them.
   */
  handOffRenewal(): void;
}

const fatDeliveryContext = new AsyncLocalStorage<FatDeliveryContext>();

/** The delivery the calling handler is running under, if it is a fat one. */
export function currentFatDelivery(): FatDeliveryContext | undefined {
  return fatDeliveryContext.getStore();
}

/**
 * Hold the first lease before this delivery queues for an execution slot.
 *
 * Returns null when the delivery must not run, having already been settled.
 */
async function preGateLease(
  msg: JsMsg, deps: DeliveryDeps, target: FatTarget,
): Promise<Extract<Acceptance, { kind: "held" }> | null> {
  const acceptance = await deps.fatPreGate!.accept(target);
  if (acceptance.kind === "gone") {
    msg.ack();
    return null;
  }
  if (acceptance.kind === "refused") {
    msg.nak(deps.surplusNakMs(msg.info?.deliveryCount ?? 1));
    return null;
  }
  return acceptance;
}

/**
 * Start renewing the pre-gate lease and expose the stop it may raise.
 *
 * The renewal is also the stop channel, which is what makes a Stop durable for
 * a delivery no interrupt subject can reach yet: nothing subscribes for this
 * run until the handler starts, and the row is the only thing that can be told
 * in the meantime.
 */
function armPreGate(
  deps: DeliveryDeps,
  target: FatTarget,
  runClaim: number | undefined,
  initial: DeliveryStop | null,
): { heartbeat: PreGateHeartbeat | null; signal: Promise<DeliveryStop>; raised(): DeliveryStop | null } {
  let raised = initial;
  let resolveStop!: (reason: DeliveryStop) => void;
  const signal = new Promise<DeliveryStop>((resolve) => { resolveStop = resolve; });
  if (initial) {
    resolveStop(initial);
    return { heartbeat: null, signal, raised: () => raised };
  }
  const heartbeat = deps.fatPreGate!.heartbeat(target, runClaim, (reason) => {
    raised ??= reason;
    resolveStop(reason);
  });
  return { heartbeat, signal, raised: () => raised };
}

/**
 * Settle a delivery the row ended while it was queued for a slot.
 *
 * A Stop is settled visibly as well as durably: the interrupted completion is
 * what moves the row from `cancelling` to `cancelled` and hands the session
 * gate back, so a delivery that merely acked would leave the turn open. The
 * other two are losses rather than stops -- `gone` is a row nobody holds and
 * nothing is waiting for, `superseded` belongs to the worker that took it and
 * this one touches none of it.
 */
async function settleStopped(
  msg: JsMsg, deps: DeliveryDeps, target: FatTarget,
  runClaim: number | undefined, stop: DeliveryStop,
): Promise<void> {
  if (stop === "cancelling") {
    await deps.fatPreGate!.settleStopped(target, runClaim);
    msg.ack();
    return;
  }
  if (stop === "gone") msg.ack();
  else msg.nak(deps.surplusNakMs(msg.info?.deliveryCount ?? 1));
}

/**
 * Wait for a slot, or for the row to say the delivery is over.
 *
 * `ExecutionGate.acquire` has no cancellation and counts the slot as it hands
 * it over, so a delivery the stop signal frees must not walk away from a queued
 * acquire: that slot would be granted to nobody and lost for the pod's life.
 * The release is attached to the still-pending acquisition instead, leaving
 * exactly one releaser for every acquire -- the delivery's own `finally` when
 * the gate won, that continuation when the stop did.
 *
 * @returns whether this delivery now holds a slot.
 */
async function raceGateAgainstStop(
  deps: DeliveryDeps, stopped: Promise<DeliveryStop>,
): Promise<boolean> {
  const acquired = deps.gate.acquire();
  const won = await Promise.race([acquired.then(() => true), stopped.then(() => false)]);
  if (won) return true;
  void acquired.then(() => deps.gate.release()).catch(() => {});
  return false;
}

export interface DeliveryDeps {
  /** Start telling the server this delivery is being worked on; returns the stop. */
  keepAlive(msg: JsMsg): () => void;
  /** This pod's execution slots. Every acquire needs exactly one release. */
  gate: { acquire(): Promise<void>; release(): void; admissible(): boolean };
  /** This pod's ceiling on deliveries held at once. */
  residency: Pick<DeliveryResidency, "take" | "leave">;
  /**
   * Whether this delivery may still be handed back for lack of room.
   *
   * False once the allowance is spent, and false while the message is close
   * enough to the poison guard that a refusal could be what trips it. Past
   * either, a full pod keeps the message rather than refusing it.
   */
  canRefuse(deliveryCount: number): boolean;
  /**
   * How long a delivery refused for lack of room waits, given how many times
   * it has been delivered. Passed in so this module keeps its own weight and
   * the curve stays the one a refused delivery already uses elsewhere.
   */
  surplusNakMs(deliveryCount: number): number;
  /** Whether this pod is shutting down and must start nothing new. */
  isDraining(): boolean;
  handle(msg: JsMsg): Promise<void>;
  onError(err: unknown): void;
  /** A delivery this pod is not going to run. Optional so tests can omit it. */
  onRefuse?(kind: "surplus" | "drain"): void;
  /**
   * A doorbell, not the work. A full pod acks it rather than keeping it:
   * the run lives on the row and an idle replica will claim-next.
   */
  isWakeup?(msg: JsMsg): boolean;
  /**
   * The durable holder protocol for fat deliveries. Optional: a pod wired
   * without one runs every delivery the way it always did.
   */
  fatPreGate?: FatPreGate;
}

/**
 * Carry one delivery through queueing, execution and settlement.
 *
 * Deliberately not awaited by its caller. Awaiting it is the thing this
 * function exists to stop the delivery loop doing.
 *
 * Which is also why it must not reject: with nobody awaiting it, a rejection is
 * an unhandled one, and under Node's default that ends the process. The throw
 * to worry about is not in `handle` -- it is `msg.nak` on a connection that is
 * already closing, so the pod would be taken down in the middle of the drain it
 * was trying to perform, killing every run that was checkpointing. Everything is
 * therefore inside the try below, including the checks that decide whether this
 * pod will take the delivery at all, and every failure leaves through onError.
 *
 * The heartbeat starts before the wait for a slot and covers everything after
 * it: queueing, the dispatch checks, and execution. Without it the only thing
 * keeping a held message from being redelivered is ack_wait being longer than
 * anything that can happen to it, which is why ack_wait used to be ten minutes.
 * The run's own keepalive covers the execution part as well and is left alone;
 * a duplicate progress ack costs one small message.
 *
 * The drain is asked about twice, before the wait and after it, because the
 * answer changes across a wait that lasts a whole run. A delivery that passed
 * the first check and then waited would otherwise start a fresh run after the
 * SIGTERM sweep over the abort registry had already run: too late to be told to
 * checkpoint, and hard-killed at the end of the grace period with nothing
 * written.
 */
export async function runDelivery(msg: JsMsg, deps: DeliveryDeps): Promise<void> {
  // Both tracked rather than assumed, because the `finally` has to give back
  // exactly what was taken: releasing a slot this delivery never acquired
  // decrements the count on behalf of a run that is still using one, and the
  // pod then admits one task too many for the rest of its life. A place kept
  // for a delivery that has gone is the same arithmetic from the other side,
  // and MAX_RESIDENT of those is a pod that has quietly stopped accepting work.
  let taken = false;
  let slotHeld = false;
  let stopHeartbeat = (): void => {};
  let preGate: PreGateHeartbeat | null = null;
  try {
    if (deps.isDraining()) {
      deps.onRefuse?.("drain");
      msg.nak(DRAIN_NAK_MS);
      return;
    }
    // Asked before the heartbeat, because a delivery this pod is not going to
    // hold is one it must not be telling the server it is working on.
    // The gate, not residency: a pod at MAX_CONCURRENT never fills a ceiling
    // of MAX_RESIDENT + MAX_CONCURRENT, and refusing only then is how one
    // busy replica held work for hours while others sat idle.
    const deliveries = msg.info?.deliveryCount ?? 1;
    const wakeup = deps.isWakeup?.(msg) === true;
    if (!deps.gate.admissible() && (wakeup || deps.canRefuse(deliveries))) {
      deps.onRefuse?.("surplus");
      if (wakeup) {
        msg.ack();
        return;
      }
      msg.nak(deps.surplusNakMs(deliveries));
      return;
    }
    // The first lease before anything else this pod might have to give back.
    // A delivery refused here was never accepted and holds no durable state,
    // which is what lets it be handed straight back to the fleet.
    const target = deps.fatPreGate?.target(msg) ?? null;
    const acceptance = target ? await preGateLease(msg, deps, target) : null;
    if (target && !acceptance) return;
    const arm = target && acceptance
      ? armPreGate(deps, target, acceptance.runClaim, acceptance.stop ?? null)
      : null;
    preGate = arm?.heartbeat ?? null;

    // Past here the pod is holding this delivery whether or not it had room:
    // a message with no budget left to spend is kept rather than refused.
    // Counted even over the ceiling, otherwise finishing an in-ceiling run
    // makes the pod look empty while the overflow is still held, and surplus
    // is admitted on top of it -- the stall this ceiling exists to prevent.
    deps.residency.take();
    taken = true;
    stopHeartbeat = deps.keepAlive(msg);

    if (!target || !acceptance || !arm) {
      await deps.gate.acquire();
      slotHeld = true;
      if (deps.isDraining()) {
        deps.onRefuse?.("drain");
        msg.nak(DRAIN_NAK_MS);
        return;
      }
      await deps.handle(msg);
      return;
    }

    const runClaim = acceptance.runClaim;
    if (!arm.raised()) slotHeld = await raceGateAgainstStop(deps, arm.signal);
    if (deps.isDraining() && !arm.raised()) {
      deps.onRefuse?.("drain");
      msg.nak(DRAIN_NAK_MS);
      return;
    }
    // The handler must not run once a signal has been raised, whichever of the
    // two resolved the race: a Stop the user made is durable on the row, and
    // starting the turn now would burn a sandbox on work already withdrawn.
    const stop = arm.raised();
    if (stop) {
      await settleStopped(msg, deps, target, runClaim, stop);
      return;
    }
    await fatDeliveryContext.run(
      { runClaim, handOffRenewal: () => arm.heartbeat?.stop() },
      () => deps.handle(msg),
    );
  } catch (err) {
    deps.onError(err);
  } finally {
    stopHeartbeat();
    preGate?.stop();
    if (slotHeld) deps.gate.release();
    if (taken) deps.residency.leave();
  }
}

/** What the concrete pre-gate needs that this module cannot reach on its own. */
export interface FatPreGateDeps {
  /** Publish an event for a session, as the task emitter does. */
  emit(sessionId: string, event: Record<string, unknown>): Promise<void>;
  /** The lease POST. A seam so a test can answer it without a server. */
  ask?: typeof askRunLease;
  brainId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
}

/** The statuses a row may answer a lease with and still be this pod's to run. */
const RENEWABLE_STATUSES = new Set(["preparing", "running", "cancelling"]);

const PRE_GATE_INTERRUPT_TEXT = "[Interrupted by user before any turn completed]";

/**
 * The durable holder protocol for fat chat deliveries.
 *
 * Acceptance is the first lease: one statement that writes owner, expiry and
 * generation, so there is no window in which this pod is queued for an
 * execution slot with nothing on the row to say so.
 */
export function createFatPreGate(deps: FatPreGateDeps): FatPreGate {
  const ask = deps.ask ?? askRunLease;
  const brainId = deps.brainId ?? BRAIN_ID;
  const leaseSeconds = Math.ceil((deps.leaseTtlMs ?? RUN_LEASE_TTL_MS) / 1000);
  const heartbeatMs = deps.heartbeatMs ?? RUN_LEASE_HEARTBEAT_MS;
  const body = (runClaim: number | undefined, accept?: true): LeaseRenewal => ({
    brainId,
    leaseSeconds,
    // The delivery is queued for a slot rather than running, which is exactly
    // the distinction the phase was added to measure.
    phase: "waiting",
    waitedMs: 0,
    waits: 0,
    ...(runClaim === undefined ? {} : { runClaim }),
    ...(accept ? { accept } : {}),
  });

  return {
    target(msg) {
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(msg.data));
      } catch {
        return null;
      }
      if (!payload || typeof payload !== "object" || isRunDoorbell(payload)) return null;
      const request = payload as ExecuteRequest;
      if (!request.run_lease?.url) return null;
      // The marker, or the shape a fat message published before the marker
      // existed has: a chat delivery carries no `callback_url`, and a DAG or
      // script run that carries one is not this path's work.
      return request.run_lease.accept_before_execution === true || !request.callback_url
        ? request
        : null;
    },

    async accept(target) {
      const answer = await ask(target, body(undefined, true));
      if (answer.kind === "refused") {
        return answer.refusal === "gone" ? { kind: "gone" } : { kind: "refused" };
      }
      // No verdict is not a lease. A mid-run heartbeat may wait for the next
      // tick; an acceptance has nothing to fall back on, and treating one as
      // success is how a delivery reaches the gate holding nothing.
      if (answer.kind !== "granted" || !RENEWABLE_STATUSES.has(answer.status)) {
        return { kind: "refused" };
      }
      return {
        kind: "held",
        ...(answer.claimCount === undefined ? {} : { runClaim: answer.claimCount }),
        ...(answer.status === "cancelling" ? { stop: "cancelling" as const } : {}),
      };
    },

    heartbeat(target, runClaim, onStop) {
      const timer = setInterval(() => {
        void ask(target, body(runClaim)).then((answer) => {
          if (answer.kind === "refused") return onStop(answer.refusal);
          if (answer.kind === "granted" && answer.status === "cancelling") {
            return onStop("cancelling");
          }
          // Anything else is transient: the next tick asks again, and the
          // lease outlives several of them.
        }).catch(() => { /* askRunLease already logs; a failure is not a verdict */ });
      }, heartbeatMs);
      timer.unref?.();
      return { stop: () => clearInterval(timer) };
    },

    async settleStopped(target, runClaim) {
      await deps.emit(target.session_id, {
        type: "exec_complete",
        session_id: target.session_id,
        message_id: target.message_id ?? "",
        user_id: target.user_id || "default",
        final_text: PRE_GATE_INTERRUPT_TEXT,
        interrupted: true,
        failed: false,
        turns: 0,
        ...(target.task_id ? { task_id: target.task_id } : {}),
        ...(runClaim === undefined ? {} : { run_claim: runClaim }),
      });
    },
  };
}
